const { expect } = require("chai");
const { ethers } = require("hardhat");

const RESOURCE = ethers.keccak256(ethers.toUtf8Bytes("https://api.example.com/premium"));

async function deploy() {
  const [owner, relayer, payer, merchant, treasury, attacker] = await ethers.getSigners();

  const Permit2 = await ethers.getContractFactory("Permit2");
  const permit2 = await Permit2.deploy();

  const Mock = await ethers.getContractFactory("MockERC20");
  const usdg = await Mock.deploy("Global Dollar", "USDG", 6);
  const meme = await Mock.deploy("Meme", "MEME", 18);

  const Router = await ethers.getContractFactory("MockRouter");
  const router = await Router.deploy(usdg, permit2);
  // 1 USDG (1e6) costs 1000 MEME (1000e18): num/den = 1000e18 / 1e6
  await router.setPrice(10n ** 21n, 10n ** 6n);

  const Settlement = await ethers.getContractFactory("TenderSettlement");
  const tender = await Settlement.deploy(owner, permit2, usdg, treasury);

  await tender.setRelayer(relayer, true);
  await tender.setRouter(router, true, false);

  // payer holds MEME and approved Permit2 once (the step Tender gas-sponsors)
  await meme.mint(payer, ethers.parseEther("1000000"));
  await meme.connect(payer).approve(permit2, ethers.MaxUint256);

  return { owner, relayer, payer, merchant, treasury, attacker, permit2, usdg, meme, router, tender };
}

async function signPayment(ctx, { token, maxIn, nonce = 0n, deadline, payment, signer }) {
  const { permit2, tender, payer } = ctx;
  const net = await ethers.provider.getNetwork();
  const domain = { name: "Permit2", chainId: net.chainId, verifyingContract: await permit2.getAddress() };
  const types = {
    PermitWitnessTransferFrom: [
      { name: "permitted", type: "TokenPermissions" },
      { name: "spender", type: "address" },
      { name: "nonce", type: "uint256" },
      { name: "deadline", type: "uint256" },
      { name: "witness", type: "Payment" },
    ],
    TokenPermissions: [
      { name: "token", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    Payment: [
      { name: "merchant", type: "address" },
      { name: "amountOut", type: "uint256" },
      { name: "fee", type: "uint256" },
      { name: "resource", type: "bytes32" },
    ],
  };
  const dl = deadline ?? BigInt((await ethers.provider.getBlock("latest")).timestamp + 600);
  const permit = { permitted: { token: await token.getAddress(), amount: maxIn }, nonce, deadline: dl };
  const value = { ...permit, spender: await tender.getAddress(), witness: payment };
  const sig = await (signer ?? payer).signTypedData(domain, types, value);
  return { permit, sig };
}

function swapCall(ctx, token, amountOut, maxIn, viaPermit2 = false) {
  return ctx.router.interface.encodeFunctionData("swapExactOut", [
    token.target,
    amountOut,
    maxIn,
    ctx.tender.target,
    viaPermit2,
  ]);
}

describe("TenderSettlement", function () {
  let ctx;
  beforeEach(async () => {
    ctx = await deploy();
  });

  async function basicPayment(amountOut = 5_000_000n /* 5 USDG */) {
    const fee = await ctx.tender.quoteFee(ctx.meme, amountOut);
    return { merchant: ctx.merchant.address, amountOut, fee, resource: RESOURCE };
  }

  it("quotes a 0.5% fee, rounded up", async () => {
    expect(await ctx.tender.quoteFee(ctx.meme, 5_000_000n)).to.equal(25_000n);
    expect(await ctx.tender.quoteFee(ctx.meme, 1n)).to.equal(1n);
  });

  it("settles: merchant gets exact USDG, treasury gets fee, payer gets leftover back", async () => {
    const { tender, relayer, payer, merchant, treasury, meme, usdg, router } = ctx;
    const payment = await basicPayment();
    const maxIn = ethers.parseEther("6000"); // needs 5025 MEME, 975 spare
    const { permit, sig } = await signPayment(ctx, { token: meme, maxIn, payment });
    const data = swapCall(ctx, meme, payment.amountOut + payment.fee, maxIn);

    const before = await meme.balanceOf(payer);
    await expect(tender.connect(relayer).settle(permit, payer, payment, sig, router, data))
      .to.emit(tender, "Settled")
      .withArgs(payer.address, merchant.address, meme.target, ethers.parseEther("5025"), 5_000_000n, 25_000n, RESOURCE);

    expect(await usdg.balanceOf(merchant)).to.equal(5_000_000n);
    expect(await usdg.balanceOf(treasury)).to.equal(25_000n);
    expect(before - (await meme.balanceOf(payer))).to.equal(ethers.parseEther("5025"));
    expect(await meme.balanceOf(tender)).to.equal(0n);
    expect(await usdg.balanceOf(tender)).to.equal(0n);
    expect(await meme.allowance(tender, router)).to.equal(0n);
  });

  it("works with a Permit2-style router (Universal Router mode) and revokes after", async () => {
    const { tender, owner, relayer, payer, merchant, meme, usdg, router, permit2 } = ctx;
    await tender.connect(owner).setRouter(router, true, true);
    const payment = await basicPayment();
    const maxIn = ethers.parseEther("6000");
    const { permit, sig } = await signPayment(ctx, { token: meme, maxIn, payment });
    const data = swapCall(ctx, meme, payment.amountOut + payment.fee, maxIn, true);

    await tender.connect(relayer).settle(permit, payer, payment, sig, router, data);
    expect(await usdg.balanceOf(merchant)).to.equal(5_000_000n);
    const [amt] = await permit2.allowance(tender, meme, router);
    expect(amt).to.equal(0n);
  });

  it("charges no fee for a fee-exempt token", async () => {
    const { tender, owner, relayer, payer, treasury, meme, usdg, router } = ctx;
    await tender.connect(owner).setFeeExempt(meme, true);
    const payment = await basicPayment();
    expect(payment.fee).to.equal(0n);
    const maxIn = ethers.parseEther("6000");
    const { permit, sig } = await signPayment(ctx, { token: meme, maxIn, payment });
    await tender.connect(relayer).settle(permit, payer, payment, sig, router, swapCall(ctx, meme, payment.amountOut, maxIn));
    expect(await usdg.balanceOf(treasury)).to.equal(0n);
  });

  it("returns surplus USDG to the payer", async () => {
    const { tender, relayer, payer, meme, usdg, router } = ctx;
    const payment = await basicPayment();
    const maxIn = ethers.parseEther("6000");
    const { permit, sig } = await signPayment(ctx, { token: meme, maxIn, payment });
    const data = swapCall(ctx, meme, payment.amountOut + payment.fee + 7n, maxIn);
    await tender.connect(relayer).settle(permit, payer, payment, sig, router, data);
    expect(await usdg.balanceOf(payer)).to.equal(7n);
  });

  it("rejects a relayer that changes the merchant (signature no longer matches)", async () => {
    const { tender, relayer, payer, attacker, meme, router } = ctx;
    const payment = await basicPayment();
    const maxIn = ethers.parseEther("6000");
    const { permit, sig } = await signPayment(ctx, { token: meme, maxIn, payment });
    const forged = { ...payment, merchant: attacker.address };
    const data = swapCall(ctx, meme, payment.amountOut + payment.fee, maxIn);
    await expect(tender.connect(relayer).settle(permit, payer, forged, sig, router, data)).to.be.reverted;
  });

  it("rejects a raised amount or a fee below the minimum", async () => {
    const { tender, relayer, payer, meme, router } = ctx;
    const payment = await basicPayment();
    const maxIn = ethers.parseEther("6000");
    const { permit, sig } = await signPayment(ctx, { token: meme, maxIn, payment });
    const data = swapCall(ctx, meme, payment.amountOut + payment.fee, maxIn);
    await expect(
      tender.connect(relayer).settle(permit, payer, { ...payment, fee: 0n }, sig, router, data)
    ).to.be.revertedWithCustomError(tender, "FeeBelowMinimum");
    await expect(
      tender.connect(relayer).settle(permit, payer, { ...payment, amountOut: payment.amountOut * 2n, fee: payment.fee * 2n }, sig, router, data)
    ).to.be.reverted;
  });

  it("reverts on a bad fill and the payer keeps their tokens", async () => {
    const { tender, relayer, payer, meme, router } = ctx;
    await router.setShortfall(1n);
    const payment = await basicPayment();
    const maxIn = ethers.parseEther("6000");
    const { permit, sig } = await signPayment(ctx, { token: meme, maxIn, payment });
    const before = await meme.balanceOf(payer);
    await expect(
      tender.connect(relayer).settle(permit, payer, payment, sig, router, swapCall(ctx, meme, payment.amountOut + payment.fee, maxIn))
    ).to.be.revertedWithCustomError(tender, "InsufficientOutput");
    expect(await meme.balanceOf(payer)).to.equal(before);
  });

  it("caps the router at what the payer signed", async () => {
    const { tender, relayer, payer, meme, router } = ctx;
    const payment = await basicPayment();
    const maxIn = ethers.parseEther("6000");
    const { permit, sig } = await signPayment(ctx, { token: meme, maxIn, payment });
    const data = router.interface.encodeFunctionData("greedy", [meme.target, ethers.parseEther("7000")]);
    await expect(tender.connect(relayer).settle(permit, payer, payment, sig, router, data)).to.be.revertedWithCustomError(
      tender,
      "SwapFailed"
    );
  });

  it("blocks replays of the same signature", async () => {
    const { tender, relayer, payer, meme, router } = ctx;
    const payment = await basicPayment();
    const maxIn = ethers.parseEther("6000");
    const { permit, sig } = await signPayment(ctx, { token: meme, maxIn, payment });
    const data = swapCall(ctx, meme, payment.amountOut + payment.fee, maxIn);
    await tender.connect(relayer).settle(permit, payer, payment, sig, router, data);
    await expect(tender.connect(relayer).settle(permit, payer, payment, sig, router, data)).to.be.reverted;
  });

  it("rejects expired signatures", async () => {
    const { tender, relayer, payer, meme, router } = ctx;
    const payment = await basicPayment();
    const maxIn = ethers.parseEther("6000");
    const { permit, sig } = await signPayment(ctx, { token: meme, maxIn, payment, deadline: 1n });
    await expect(
      tender.connect(relayer).settle(permit, payer, payment, sig, router, swapCall(ctx, meme, payment.amountOut + payment.fee, maxIn))
    ).to.be.reverted;
  });

  it("enforces relayer, router allowlist, USDG input, pause and size cap", async () => {
    const { tender, owner, relayer, attacker, payer, meme, usdg, router } = ctx;
    const payment = await basicPayment();
    const maxIn = ethers.parseEther("6000");
    const { permit, sig } = await signPayment(ctx, { token: meme, maxIn, payment });
    const data = swapCall(ctx, meme, payment.amountOut + payment.fee, maxIn);

    await expect(tender.connect(attacker).settle(permit, payer, payment, sig, router, data)).to.be.revertedWithCustomError(tender, "NotRelayer");
    await expect(tender.connect(relayer).settle(permit, payer, payment, sig, attacker, data)).to.be.revertedWithCustomError(tender, "RouterNotAllowed");

    const zeroPermit = { ...permit, permitted: { token: ethers.ZeroAddress, amount: 1n } };
    await expect(tender.connect(relayer).settle(zeroPermit, payer, payment, sig, router, data)).to.be.revertedWithCustomError(tender, "BadToken");

    await tender.connect(owner).setPaused(true);
    await expect(tender.connect(relayer).settle(permit, payer, payment, sig, router, data)).to.be.revertedWithCustomError(tender, "IsPaused");
    await tender.connect(owner).setPaused(false);

    await tender.connect(owner).setMaxAmountOut(1_000_000n);
    await expect(tender.connect(relayer).settle(permit, payer, payment, sig, router, data)).to.be.revertedWithCustomError(tender, "AmountTooLarge");
  });

  it("accepts a signed gas fee on top of the minimum, up to the cap", async () => {
    const { tender, relayer, payer, treasury, meme, usdg, router } = ctx;
    const base = await basicPayment();
    const payment = { ...base, fee: base.fee + 30_000n }; // + $0.03 gas
    const maxIn = ethers.parseEther("6000");
    const { permit, sig } = await signPayment(ctx, { token: meme, maxIn, payment });
    await tender.connect(relayer).settle(permit, payer, payment, sig, router, swapCall(ctx, meme, payment.amountOut + payment.fee, maxIn));
    expect(await usdg.balanceOf(treasury)).to.equal(55_000n);

    const greedy = { ...base, fee: base.fee + 1_000_001n }; // over the 1 USDG gas cap
    const s2 = await signPayment(ctx, { token: meme, maxIn, payment: greedy, nonce: 1n });
    await expect(
      tender.connect(relayer).settle(s2.permit, payer, greedy, s2.sig, router, swapCall(ctx, meme, greedy.amountOut + greedy.fee, maxIn))
    ).to.be.revertedWithCustomError(tender, "FeeAboveMaximum");
  });

  it("pays USDG directly with only the gas fee, no router needed", async () => {
    const { tender, relayer, payer, merchant, treasury, usdg, permit2 } = ctx;
    await usdg.mint(payer, 1_000_000n);
    await usdg.connect(payer).approve(permit2, ethers.MaxUint256);
    expect(await tender.quoteFee(usdg, 50_000n)).to.equal(0n);
    const payment = { merchant: merchant.address, amountOut: 50_000n, fee: 20_000n, resource: RESOURCE };
    const { permit, sig } = await signPayment(ctx, { token: usdg, maxIn: 70_000n, payment });
    await expect(tender.connect(relayer).settle(permit, payer, payment, sig, ethers.ZeroAddress, "0x"))
      .to.emit(tender, "Settled")
      .withArgs(payer.address, merchant.address, usdg.target, 70_000n, 50_000n, 20_000n, RESOURCE);
    expect(await usdg.balanceOf(merchant)).to.equal(50_000n);
    expect(await usdg.balanceOf(treasury)).to.equal(20_000n);
    expect(await usdg.balanceOf(payer)).to.equal(930_000n);
    expect(await usdg.balanceOf(tender)).to.equal(0n);
  });

  it("only the owner can change settings, and the fee is capped at 1%", async () => {
    const { tender, owner, attacker } = ctx;
    await expect(tender.connect(attacker).setFeeBps(10)).to.be.revertedWithCustomError(tender, "OwnableUnauthorizedAccount");
    await expect(tender.connect(owner).setFeeBps(101)).to.be.revertedWithCustomError(tender, "FeeTooHigh");
    await tender.connect(owner).setFeeBps(100);
    expect(await tender.feeBps()).to.equal(100);
  });
});
