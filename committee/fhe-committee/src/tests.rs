use super::*;

/// One run through every piece: setup, a proven input, the coprocessor, a distributed
/// decryption. The key set takes most of the time, so it is made once.
#[test]
fn input_evaluated_and_decrypted_by_the_committee() {
    let mut rng = AesRng::seed_from_u64(7);
    let (public, shares) = setup(&mut rng).unwrap();
    let metadata = b"chain 8141, request 1";
    let input = encrypt(&public, 41, metadata).unwrap();
    assert!(verify_input(&public, &input, metadata).unwrap());
    assert!(!verify_input(&public, &input, b"another request").unwrap());
    assert!(evaluate(&public, &input, b"another request", Op::Add(1)).is_err());

    let result = evaluate(&public, &input, metadata, Op::Add(1)).unwrap();
    let d = decrypt(&public, &shares, &result).unwrap();
    assert_eq!(d.value, 42);
    for m in &d.members {
        assert!(m.bytes_sent > 0 && m.rounds > 0);
    }
    let sent: usize = d.members.iter().map(|m| m.bytes_sent).sum();
    let received: usize = d.members.iter().map(|m| m.bytes_received).sum();
    assert_eq!(sent, received);
    println!("{}", serde_json::to_string_pretty(&d).unwrap());

    // Two owners' inputs compared, each under its own metadata.
    let (ma, mb) = (b"session 1, owner a".as_slice(), b"session 1, owner b".as_slice());
    let (a, b) = (encrypt(&public, 700, ma).unwrap(), encrypt(&public, 650, mb).unwrap());
    assert_eq!(decrypt(&public, &shares, &compare(&public, &a, ma, &b, mb).unwrap()).unwrap().value, 1);
    assert_eq!(decrypt(&public, &shares, &compare(&public, &b, mb, &a, ma).unwrap()).unwrap().value, 0);
    assert!(compare(&public, &a, mb, &b, mb).is_err());
}
