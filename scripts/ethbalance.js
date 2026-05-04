async function main() {
    const txHash = "0x2e7b4ab4685adeb64f087e4550c32c6aed30c36f897c30b333ce33244d12cb3f";

    const trace = await network.provider.send("debug_traceTransaction", [
        txHash,
        { tracer: "callTracer" }
    ]);

    console.dir(trace, { depth: null });
}

main().catch(console.error);