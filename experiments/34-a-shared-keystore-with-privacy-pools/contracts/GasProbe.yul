// Experiment 34, arm B: a measuring probe. Called in a SENDER frame of the same transaction as a
// withdrawal, with calldata target (32) || call data, it staticcalls the target with the call data,
// as the pool calls the ownership checker, and logs the gas the call used, its outcome included.
object "GasProbe" {
    code {
        datacopy(0, dataoffset("runtime"), datasize("runtime"))
        return(0, datasize("runtime"))
    }
    object "runtime" {
        code {
            let target := calldataload(0)
            let len := sub(calldatasize(), 32)
            calldatacopy(0, 32, len)
            let g := gas()
            let ok := staticcall(gas(), target, 0, len, 0, 0)
            let used := sub(g, gas())
            mstore(0, used)
            mstore(32, ok)
            log0(0, 64)
            stop()
        }
    }
}
