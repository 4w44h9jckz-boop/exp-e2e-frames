// Experiment 17 (X12), checked offline before anything touches the chain:
// - ERC-8441 schemeId 3 as implemented here reproduces the scheme's own vectors V3-06, V3-09, V3-16
//   and V3-17;
// - an S and an N entry made here are found by their recipient and by no one else;
// - full blobs of each kind pack, unpack, and open at element i's domain point to element i.
//
// usage: npx tsx experiments/17-x12-ciphertexts-in-blobs/selfcheck.ts
import { readFileSync } from 'node:fs'
import { secp256k1 } from '@noble/curves/secp256k1'
import { ml_kem768 } from '@noble/post-quantum/ml-kem.js'
import { bytesToHex, hexToBytes } from 'viem'
import * as B from './blob.js'
import * as P from './payloads.js'

const here = new URL('.', import.meta.url).pathname
const V = JSON.parse(readFileSync(`${here}vectors/erc8441.json`, 'utf8'))
const h = (s: string) => hexToBytes(`0x${s}`)
const hex = (b: Uint8Array) => bytesToHex(b).slice(2)
let failed = 0
const check = (what: string, ok: boolean) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed++ }

// V3-09: keygen from the 128-byte seed.
{
  const v = V['V3-09']
  const { recipient, tracking, master } = P.keygen(h(v.given.keygen_seed))
  check('V3-09 meta-address', hex(recipient.meta) === v.expect.meta_address)
  check('V3-09 tracking key', hex(P.cat(tracking.viewingEc, h(v.given.keygen_seed).slice(64))) === v.expect.tracking)
  check('V3-09 master', hex(master) === v.expect.master)
}

// V3-06: the combiner, from esk and the deterministic encapsulation with m.
{
  const v = V['V3-06']
  const p = v.given.parts
  const esk = h(v.given.esk)
  check('V3-06 epk = esk*G', hex(secp256k1.getPublicKey(esk, true)) === p.epk)
  check('V3-06 ss_ec', hex(P.ecdhX(esk, h(p.viewing_pk_ec))) === p.ss_ec)
  const { cipherText, sharedSecret } = ml_kem768.encapsulate(h(p.ek), h(v.given.m))
  check('V3-06 ct and ss_pq from Encaps_internal(ek, m)', hex(cipherText) === p.ct && hex(sharedSecret) === p.ss_pq)
  check('V3-06 ss', hex(P.hybridCombine(h(p.ss_ec), h(p.ss_pq), h(p.epk), h(p.ct), h(p.viewing_pk_ec), h(p.ek))) === v.expect.ss)
}

// V3-16: offset, stealth key pair and address.
{
  const v = V['V3-16']
  const ss = h(v.given.ss)
  check('V3-16 H(ss)', P.offsetOf(ss).toString(16).padStart(64, '0') === v.expect.H_ss)
  check('V3-16 stealth_pk', hex(P.stealthPkOf(h(v.given.spending_pk), ss)) === v.expect.stealth_pk)
  check('V3-16 address', hex(P.addressOf(h(v.expect.stealth_pk))) === v.expect.address)
}

// V3-17: a scan with ACVP's decapsulation key 86; the honest address matches, the lie is a skip.
{
  const v = V['V3-17']
  const g = v.given
  const recipient = { spendingPk: h(g.spending_pk), viewingPk: h(g.viewing_pk_ec), ek: h(g.ek), meta: new Uint8Array() }
  const tracking = { viewingEc: h(g.viewing_ec), dk: h(V.acvp_decapsulation_tcId_86.dk), recipient }
  const epkCt = h(g.announcement.ephemeralPubKey)
  const entry = (addr: string) => P.cat(h(addr), epkCt, h(g.announcement.metadata))
  const ss = P.scanS(tracking, entry(g.stealthAddress_honest))
  check('V3-17 honest address: a match, with the vector\'s ss', ss !== undefined && hex(ss) === v.expect.ss)
  check('V3-17 lying address: a skip', P.scanS(tracking, entry(g.stealthAddress_lie)) === undefined)
}

// Round trips of both payloads, with randomness drawn here.
const rnd = (n: number) => crypto.getRandomValues(new Uint8Array(n))
const seed128 = () => { for (;;) { const s = rnd(128); try { P.keygen(s); return s } catch { /* draw again */ } } }
const esk = () => secp256k1.utils.randomPrivateKey()
{
  const me = P.keygen(seed128())
  const other = P.keygen(seed128())
  const a = P.announce(me.recipient, esk(), rnd(32))
  const entry = P.encodeS(a)
  check(`S entry is ${P.S_BYTES} bytes`, entry.length === P.S_BYTES)
  const found = P.scanS(me.tracking, entry)
  check('S found by its recipient, with the sender\'s ss', found !== undefined && hex(found) === hex(a.ss))
  check('S skipped by another recipient', P.scanS(other.tracking, entry) === undefined)
  const n = P.noteKeygen(rnd(64))
  const n2 = P.noteKeygen(rnd(64))
  const opening = rnd(64)
  const sealed = P.sealNote(n.ek, opening, rnd(32))
  check(`N entry is ${P.N_BYTES} bytes`, sealed.length === P.N_BYTES)
  const got = P.scanN(n.dk, sealed)
  check('N opened by its recipient', got !== undefined && hex(got) === hex(opening))
  check('N skipped by another recipient', P.scanN(n2.dk, sealed) === undefined)
}

// Blobs: full of each kind, packed, unpacked, and opened.
for (const [kind, len] of [[B.KIND.S, P.S_BYTES], [B.KIND.N, P.N_BYTES]] as const) {
  const cap = B.capacity(len)
  check(`kind ${kind}: ${cap} entries of ${len} bytes per blob`, cap === (kind === B.KIND.S ? 107 : 105))
  const entries = Array.from({ length: cap }, () => rnd(len))
  const blob = B.packBlob(kind, entries)
  const back = B.unpackBlob(blob)
  check(`kind ${kind}: unpacked entries equal packed ones`, back.kind === kind && back.entries.every((e, i) => hex(e) === hex(entries[i])))
  const c = B.commitmentOf(blob)
  for (const i of [0, 1, 7, cap]) {
    const { proof, y } = B.openElement(blob, i)
    check(`kind ${kind}: the opening at element ${i}'s domain point is element ${i}`, hex(y) === hex(B.element(blob, i)) && B.verifyOpening(c, B.domainPoint(i), y, proof))
  }
  check(`kind ${kind}: element 0 is the header`, hex(B.element(blob, 0)) === hex(B.headerOf(kind, cap, len)))
  check(`kind ${kind}: domain point of element 0 is 1`, B.domainPoint(0) === 1n)
  const z = 0x1234567890abcdefn
  const { proof, y } = B.openAt(blob, z)
  check(`kind ${kind}: an opening at an arbitrary point verifies, and a changed y does not`, B.verifyOpening(c, z, y, proof) && !B.verifyOpening(c, z, Uint8Array.of(...y.slice(0, 31), y[31] ^ 1), proof))
  check(`kind ${kind}: 128 cell proofs`, B.cellProofsOf(blob).length === 128)
}

console.log(failed ? `\n${failed} failed` : '\nall passed')
process.exit(failed ? 1 : 0)
