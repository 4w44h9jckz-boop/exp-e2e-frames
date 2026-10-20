//! Reads the vector set and prints what kohaku-frame-kit computes for each case, as JSON. It
//! judges nothing: run.ts compares the answers of every implementation with the expected values.
//!
//! usage: i2-kohaku-runner VECTORS_DIR

use std::{env, fs, path::Path};

use alloy::primitives::hex;
use kohaku_frame_kit::{FrameTx, digest, json::FrameTxJson};
use serde_json::{Value, json};

fn load(dir: &Path, file: &str) -> Value {
    let text = fs::read_to_string(dir.join(file)).expect("read a vector file");
    serde_json::from_str(&text).expect("parse a vector file")
}

fn bytes(v: &Value) -> Vec<u8> {
    hex::decode(v.as_str().expect("a hex string")).expect("valid hex")
}

fn from_fields(fields: &Value) -> Result<FrameTx, String> {
    let mut j = fields.clone();
    // FrameTxJson carries the node's hash; the conversion does not read it.
    j["hash"] = json!(format!("0x{}", "00".repeat(32)));
    let parsed: FrameTxJson = serde_json::from_value(j).map_err(|e| format!("json: {e}"))?;
    FrameTx::try_from(&parsed).map_err(|e| format!("{e:?}"))
}

fn main() {
    let dir = env::args().nth(1).expect("usage: i2-kohaku-runner VECTORS_DIR");
    let dir = Path::new(&dir);

    let transactions: Vec<Value> = load(dir, "transactions.json")["cases"]
        .as_array()
        .expect("cases")
        .iter()
        .map(|c| match from_fields(&c["fields"]) {
            Ok(tx) => json!({
                "name": c["name"],
                "raw": format!("0x{}", hex::encode(tx.encode())),
                "hash": format!("{}", tx.hash()),
                "sigHash": format!("{}", tx.sig_hash()),
            }),
            Err(e) => json!({ "name": c["name"], "error": e }),
        })
        .collect();

    let reject: Vec<Value> = load(dir, "reject.json")["cases"]
        .as_array()
        .expect("cases")
        .iter()
        .map(|c| match FrameTx::decode(&bytes(&c["raw"])) {
            Ok(_) => json!({ "name": c["name"], "refused": false }),
            Err(e) => json!({ "name": c["name"], "refused": true, "error": e.to_string() }),
        })
        .collect();

    let digests: Vec<Value> = load(dir, "execution-digest.json")["cases"]
        .as_array()
        .expect("cases")
        .iter()
        .map(|c| match FrameTx::decode(&bytes(&c["raw"])) {
            Ok(tx) => json!({
                "name": c["name"],
                "domainSeparator": format!("{}", digest::execution_domain(&tx).separator()),
                "structHash": format!("{}", digest::execution_struct_hash(&tx)),
                "executionDigest": format!("{}", digest::execution_digest(&tx)),
            }),
            Err(e) => json!({ "name": c["name"], "error": e.to_string() }),
        })
        .collect();

    println!(
        "{}",
        json!({ "implementation": "kohaku-frame-kit", "transactions": transactions,
                "reject": reject, "executionDigest": digests })
    );
}
