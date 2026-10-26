use super::*;
use commonware_codec::Encode;
use kohaku_tornadocash::Note;
use rand::{SeedableRng, rngs::StdRng};
use ruint::aliases::U256;

fn fr(f: kohaku_tornadocash::Field) -> Fr {
    let u: U256 = f.into();
    Fr::from_be_bytes_mod_order(&u.to_be_bytes::<32>())
}

fn random31(rng: &mut StdRng) -> [u8; 31] {
    let mut b = [0u8; 31];
    rng.fill_bytes(&mut b);
    b
}

#[test]
fn the_pedersen_point_is_kohakus_hash() {
    let mut rng = StdRng::seed_from_u64(1);
    for _ in 0..5 {
        let (n, s) = (random31(&mut rng), random31(&mut rng));
        let note = Note::new(n, s);
        let mut pre = [0u8; 62];
        pre[..31].copy_from_slice(&n);
        pre[31..].copy_from_slice(&s);
        assert_eq!(pedersen(&pre).x, fr(note.commitment()));
        assert_eq!(pedersen(&n).x, fr(note.nullifier_hash()));
    }
}

#[test]
fn three_members_and_the_owner_make_the_note() {
    let mut rng = StdRng::seed_from_u64(2);
    for _ in 0..5 {
        let s = random31(&mut rng);
        let parts: [[u8; 31]; MEMBERS] = std::array::from_fn(|j| choose_part(j, &mut rng));
        let mut n = [0u8; 31];
        for p in &parts {
            for (x, y) in n.iter_mut().zip(p) {
                assert_eq!(*x & y, 0, "the parts are disjoint");
                *x |= y;
            }
        }
        for (j, p) in parts.iter().enumerate() {
            assert!(in_windows(j, p));
            assert!(!in_windows((j + 1) % MEMBERS, p) || *p == [0u8; 31]);
        }
        let points = parts.map(|p| a_point(&p));
        assert_eq!(commitment(&points, &b_point(&s)), fr(Note::new(n, s).commitment()));
    }
}

#[test]
fn a_packed_point_unpacks() {
    let mut rng = StdRng::seed_from_u64(3);
    let b = b_point(&random31(&mut rng));
    assert_eq!(Point::unpack(&b.pack()), Some(b));
    assert_eq!(Point::unpack(&b.neg().pack()), Some(b.neg()));
}

#[test]
fn a_sealed_message_opens_only_for_its_key_and_aad() {
    let mut rng = StdRng::seed_from_u64(4);
    let (to, other) = (seal::Keys::random(&mut rng), seal::Keys::random(&mut rng));
    let vault = [7u8; 20];
    let m = seal::seal(&to.public, b"forty-eight bytes of opening, padded to length..", seal::INFO_OPENING, &seal::aad(&vault, 3), &mut rng).unwrap();
    assert_eq!(m.len(), OPENING_LEN);
    assert!(seal::open(&to.secret, &m, seal::INFO_OPENING, &seal::aad(&vault, 3)).is_some());
    assert!(seal::open(&other.secret, &m, seal::INFO_OPENING, &seal::aad(&vault, 3)).is_none());
    assert!(seal::open(&to.secret, &m, seal::INFO_OPENING, &seal::aad(&vault, 4)).is_none());
    assert!(seal::open(&to.secret, &m, seal::INFO_INTENT, &seal::aad(&vault, 3)).is_none());
    // Two messages to the same key share no bytes but the version.
    let m2 = seal::seal(&to.public, b"forty-eight bytes of opening, padded to length..", seal::INFO_OPENING, &seal::aad(&vault, 3), &mut rng).unwrap();
    assert_ne!(m[2..35], m2[2..35]);
}

#[test]
fn an_intent_round_trips_and_an_update_opens_to_its_note() {
    let mut rng = StdRng::seed_from_u64(5);
    let committee = seal::Keys::random(&mut rng);
    let owner = seal::Keys::random(&mut rng);
    let vault = [9u8; 20];
    let s = random31(&mut rng);
    let intent = Intent { owner: owner.public, b: b_point(&s) };
    let sealed = intent.seal(&committee.public, &vault, 4, &mut rng).unwrap();
    assert_eq!(sealed.len(), INTENT_LEN);
    let read = Intent::open(&committee.secret, &sealed, &vault, 4).unwrap();
    assert_eq!(read, intent);
    assert!(Intent::open(&committee.secret, &sealed, &vault, 5).is_err());

    // The members: each its own part, the commitment from points, three openings.
    let parts: [[u8; 31]; MEMBERS] = std::array::from_fn(|j| choose_part(j, &mut rng));
    let c = commitment(&parts.map(|p| a_point(&p)), &read.b);
    let (leaf, update) = (17u32, 4u64);
    let openings: Vec<u8> = parts
        .iter()
        .enumerate()
        .flat_map(|(j, p)| Opening { part: *p, member: j as u8, leaf, update }.seal(&read.owner, &vault, &mut rng).unwrap())
        .collect();
    assert_eq!(openings.len(), OPENINGS_LEN);

    // The owner.
    let n = assemble(&owner.secret, &openings, &vault, update, leaf, &intent.b, c).unwrap();
    assert_eq!(fr(Note::new(n, s).commitment()), c);
    assert!(assemble(&committee.secret, &openings, &vault, update, leaf, &intent.b, c).is_err());
    assert!(assemble(&owner.secret, &openings, &vault, update, leaf + 1, &intent.b, c).is_err());
    let mut swapped = openings.clone();
    swapped[..OPENING_LEN].copy_from_slice(&openings[OPENING_LEN..2 * OPENING_LEN]);
    swapped[OPENING_LEN..2 * OPENING_LEN].copy_from_slice(&openings[..OPENING_LEN]);
    assert!(assemble(&owner.secret, &swapped, &vault, update, leaf, &intent.b, c).is_err());
}

#[test]
fn the_recipient_is_a_160_bit_hash() {
    let r = recipient(&[1u8; 20], &[2u8; 32], Fr::from(3u64), &[4u8; OPENINGS_LEN]);
    assert!(fr_be(r)[..12].iter().all(|b| *b == 0));
    assert_ne!(r, recipient(&[1u8; 20], &[2u8; 32], Fr::from(3u64), &[5u8; OPENINGS_LEN]));
}

#[test]
fn the_whole_committee_signs_a_reconciliation_and_two_cannot() {
    let mut rng = <rand10::rngs::StdRng as rand10::SeedableRng>::seed_from_u64(6);
    let committee = bls_committee::Committee::dkg(&mut rng, MEMBERS).unwrap();
    assert_eq!(committee.quorum(), MEMBERS);
    let m = reconcile_message(8141, &[3u8; 20], 1234, &redemption_list(&[[5u8; 32], [6u8; 32]]).1);
    let partials: Vec<_> = committee.members.iter().map(|(_, s)| reconcile_partial(s, &m)).collect();
    let sig = reconcile_signature(committee.sharing(), &m, &partials).unwrap();
    assert!(!sig.encode().is_empty());
    assert!(reconcile_signature(committee.sharing(), &m, &partials[..2]).is_err());
    let other = reconcile_message(8141, &[3u8; 20], 1235, &redemption_list(&[[5u8; 32], [6u8; 32]]).1);
    assert!(reconcile_signature(committee.sharing(), &other, &partials).is_err());
}

#[test]
fn the_list_digest_and_nonce_key_match_the_vaults_formulas() {
    // The list ascends, without repeats, and its digest is keccak256 of the list; the nonce key
    // hashes 44 bytes.
    let (list, d) = redemption_list(&[[6u8; 32], [5u8; 32], [6u8; 32]]);
    assert_eq!(list, vec![[5u8; 32], [6u8; 32]]);
    assert_eq!(d, <[u8; 32]>::from(Keccak256::digest([[5u8; 32], [6u8; 32]].concat())));
    assert_eq!(redemption_list(&[]).1, <[u8; 32]>::from(Keccak256::digest([])));
    let k = reconcile_nonce_key(1);
    let mut pre = [0u8; 44];
    pre[..12].copy_from_slice(b"X9_RECONCILE");
    pre[43] = 1;
    assert_eq!(k, <[u8; 32]>::from(Keccak256::digest(pre)));
}

/// The update, end to end in memory: a holder's note in a tree, its witness shared; an intent; the
/// members' parts, commitment and openings; the recipient bound to them; three members prove
/// over shares with that recipient, and the verifier accepts the proof for it and for nothing
/// else. Then the members pool everything they hold for the new note and find no witness.
#[test]
fn an_update_proof_binds_its_openings_and_the_members_cannot_redeem() {
    use co_withdraw::{
        WithdrawKey, circuit_inputs, extend_witness, prove, public_inputs, read_share, set_recipient,
        share_witness, verify,
    };
    use co_circom_types::Compression;
    let mut rng = StdRng::seed_from_u64(7);
    let key = WithdrawKey::load();
    let n_inst = key.num_instance_variables();

    // The holder's note, the second of two leaves.
    let held = Note::new(random31(&mut rng), random31(&mut rng));
    let other = Note::new(random31(&mut rng), random31(&mut rng));
    let mut leaves = vec![other.commitment(), held.commitment()];
    let inputs = circuit_inputs(&held, &leaves, U256::ZERO, U256::ZERO, U256::ZERO, U256::ZERO).unwrap();
    let w = extend_witness(&inputs).unwrap();
    let shares = share_witness(&w, n_inst, Compression::SeededShares, &mut rng).unwrap();

    // The intent for the new owner, the members' parts, the commitment and the openings.
    let committee = seal::Keys::random(&mut rng);
    let owner = seal::Keys::random(&mut rng);
    let vault = [0x42u8; 20];
    let s = random31(&mut rng);
    let sealed = Intent { owner: owner.public, b: b_point(&s) }.seal(&committee.public, &vault, 0, &mut rng).unwrap();
    let intent = Intent::open(&committee.secret, &sealed, &vault, 0).unwrap();
    let parts: [[u8; 31]; MEMBERS] = std::array::from_fn(|j| choose_part(j, &mut rng));
    let c = commitment(&parts.map(|p| a_point(&p)), &intent.b);
    let leaf = leaves.len() as u32;
    let openings: Vec<u8> = parts
        .iter()
        .enumerate()
        .flat_map(|(j, p)| Opening { part: *p, member: j as u8, leaf, update: 0 }.seal(&intent.owner, &vault, &mut rng).unwrap())
        .collect();
    let intent_hash: [u8; 32] = Keccak256::digest(&sealed).into();
    let r = recipient(&vault, &intent_hash, c, &openings);

    let nets = mpc_net::local::LocalNetwork::new(MEMBERS);
    let proofs: Vec<_> = std::thread::scope(|sc| {
        let handles: Vec<_> = nets
            .into_iter()
            .zip(shares.iter())
            .enumerate()
            .map(|(id, (net, share))| {
                let key = &key;
                sc.spawn(move || {
                    let mut share = read_share(share).unwrap();
                    set_recipient(&mut share, id, r).unwrap();
                    prove(&net, key, share).unwrap()
                })
            })
            .collect();
        handles.into_iter().map(|h| h.join().unwrap()).collect()
    });
    let mut public = public_inputs(&w, n_inst);
    public[2] = r;
    assert!(verify(&proofs[0], &public));
    let mut tampered = openings.clone();
    tampered[40] ^= 1;
    public[2] = recipient(&vault, &intent_hash, c, &tampered);
    assert!(!verify(&proofs[0], &public));

    // The owner's note, and what the members can do with it.
    leaves.push(kohaku_tornadocash::Field::try_from(U256::from_be_bytes(fr_be(c))).unwrap());
    let n = assemble(&owner.secret, &openings, &vault, 0, leaf, &intent.b, c).unwrap();
    let mine = Note::new(n, s);
    assert!(circuit_inputs(&mine, &leaves, U256::from(1u64), U256::ZERO, U256::ZERO, U256::ZERO).is_ok());
    for guess in [[0u8; 31], [0xffu8; 31], random31(&mut rng)] {
        let theirs = Note::new(n, guess);
        assert!(circuit_inputs(&theirs, &leaves, U256::from(1u64), U256::ZERO, U256::ZERO, U256::ZERO).is_err());
    }
}
