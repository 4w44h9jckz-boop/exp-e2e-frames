// C1's check: a fixed committee's two keys at work. The FHE half sets up its key set and shares
// it; a client encrypts one value with a proof of knowledge bound to the request; the coprocessor
// checks the proof and adds one; the four members decrypt together. The BLS half runs Commonware's
// DKG; three of four members sign the decrypted result, and two of four try. The chain's own
// EIP-2537 pairing precompile is asked, by `eth_call`, about both signatures. Nothing is sent: no
// key is needed. The record is written to test/fixtures/committee/c1-<label>.json and checked
// offline by `npm test`.
// usage: npx tsx scripts/committee-c1.ts [label]
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bls12_381 as bls } from '@noble/curves/bls12-381'
import { type Hex, bytesToHex, concatHex, hexToBytes, keccak256, numberToHex, stringToHex } from 'viem'
import { COMMITTEE_DIR, RPC_URL, buildCommittee, rpc, run } from '../src/e2e/index.js'

const label = process.argv[2] ?? new Date().toISOString().slice(0, 10)
const out = new URL('../test/fixtures/committee/', import.meta.url).pathname
const dir = mkdtempSync(join(tmpdir(), 'c1-'))

const repoCommit = (await run('git', ['rev-parse', 'HEAD'], { cwd: COMMITTEE_DIR })).trim()
const dirty = (await run('git', ['status', '--porcelain', '--', '.'], { cwd: COMMITTEE_DIR })).trim()
if (dirty) throw new Error(`commit committee/ before a recorded run:\n${dirty}`)

const bls_ = await buildCommittee('bls-committee')
await run('cargo', ['build', '--release'], { cwd: join(COMMITTEE_DIR, 'fhe-committee') })
const fhe = join(COMMITTEE_DIR, 'fhe-committee', 'target', 'release', 'fhe-committee')

const CHAIN_ID = 8141
const VALUE = 41n
const ADD = 1n
const metadata = stringToHex('C1: one request, chain 8141')
const request = keccak256(metadata)
const timed = async (cmd: string, args: string[]) => {
  const t = Date.now()
  const stdout = await run(cmd, args, { cwd: dir })
  return { stdout: stdout.trim(), millis: Date.now() - t }
}
const steps = {
  setup: await timed(fhe, ['setup', '--out', join(dir, 'fhe')]),
  encrypt: await timed(fhe, ['encrypt', '--public', join(dir, 'fhe/public'), '--value', `${VALUE}`, '--metadata', metadata, '--out', join(dir, 'input.bin')]),
  verifyInput: await timed(fhe, ['verify-input', '--public', join(dir, 'fhe/public'), '--input', join(dir, 'input.bin'), '--metadata', metadata]),
  evaluate: await timed(fhe, ['evaluate', '--public', join(dir, 'fhe/public'), '--input', join(dir, 'input.bin'), '--metadata', metadata, '--add', `${ADD}`, '--out', join(dir, 'result.bin')]),
  decrypt: await timed(fhe, ['decrypt', '--public', join(dir, 'fhe/public'), '--members', join(dir, 'fhe/members'), '--result', join(dir, 'result.bin'), '--out', join(dir, 'decryption.json')]),
  dkg: await timed(bls_, ['dkg', '--members', '4', '--out', join(dir, 'bls')]),
}
// The input's proof refused under other metadata: the coprocessor must not evaluate it.
const otherMetadata = stringToHex('C1: another request')
const refusedElsewhere = await run(fhe, ['evaluate', '--public', join(dir, 'fhe/public'), '--input', join(dir, 'input.bin'), '--metadata', otherMetadata, '--add', '1', '--out', join(dir, 'other.bin')], { cwd: dir })
  .then(() => false, () => true)

const decryption = JSON.parse(readFileSync(join(dir, 'decryption.json'), 'utf8'))
const value = decryption.value as number
const sign = async (sub: string, signers: string, file: string) => {
  await run(bls_, [sub, '--dir', join(dir, 'bls'), '--signers', signers, '--chain-id', `${CHAIN_ID}`, '--request', request,
    '--ciphertext', join(dir, 'result.bin'), '--value', `${value}`, '--out', join(dir, file)], { cwd: dir })
  return JSON.parse(readFileSync(join(dir, file), 'utf8'))
}
const signed = await sign('sign', '0,1,2', 'signed.json')
const below = await sign('sign-below', '0,1', 'below.json')
const bySignersFails = await run(bls_, ['sign', '--dir', join(dir, 'bls'), '--signers', '0,1', '--chain-id', `${CHAIN_ID}`, '--request', request,
  '--ciphertext', join(dir, 'result.bin'), '--value', `${value}`, '--out', join(dir, 'x.json')], { cwd: dir }).then(() => false, () => true)

// The chain's EIP-2537 pairing precompile (0x0f): e(sigma, -g2) e(H(m), PK) = 1, H(m) hashed
// here with noble as Commonware hashes it: union_unique(namespace, message) under the POP DST.
const DST = 'BLS_SIG_BLS12381G1_XMD:SHA-256_SSWU_RO_POP_'
const NEG_G2 = '0x00000000000000000000000000000000024aa2b2f08f0a91260805272dc51051c6e47ad4fa403b02b4510b647ae3d1770bac0326a805bbefd48056c8c121bdb80000000000000000000000000000000013e02b6052719f607dacd3a088274f65596bd0d09920b61ab5da61bbdc7f5049334cf11213945d57e5ac7d055d042b7e000000000000000000000000000000000d1b3cc2c7027888be51d9ef691d77bcb679afda66c73f17f9ee3837a55024f78c71363275a75d75d86bab79f74782aa0000000000000000000000000000000013fa4d4a0ad8b1ce186ed5061789213d993923066dddaf1040bc3ff59f825c78df74f2d75467e25e0f55f8a00fa030ed'
const ns = hexToBytes(stringToHex(signed.namespace))
const h = bls.G1.hashToCurve(new Uint8Array([ns.length, ...ns, ...hexToBytes(signed.message)]), { DST }).toAffine()
const fp = (x: bigint) => numberToHex(x, { size: 64 })
const hEip2537 = concatHex([fp(h.x), fp(h.y)])
const head = Number.parseInt(await rpc('eth_blockNumber', []), 16)
const pairing = async (sig: Hex) =>
  BigInt(await rpc('eth_call', [{ to: '0x000000000000000000000000000000000000000f', data: concatHex([sig, NEG_G2, hEip2537, signed.keyEip2537]) }, numberToHex(head)])) === 1n

const size = (f: string) => statSync(join(dir, f)).size
const record = {
  entry: 'C1',
  label,
  ranAt: new Date().toISOString(),
  repoCommit,
  pins: JSON.parse(readFileSync(join(COMMITTEE_DIR, 'pins.json'), 'utf8')),
  network: 'every member in one process on one 4-core machine, in memory: a LAN time at best',
  input: { value: Number(VALUE), metadata, op: `add ${ADD}` },
  steps: Object.fromEntries(Object.entries(steps).map(([k, v]) => [k, { millis: v.millis, stdout: v.stdout }])),
  sizes: {
    compactPublicKey: size('fhe/public/compact_public_key.bin'),
    crs: size('fhe/public/crs.bin'),
    keySet: size('fhe/public/keys.bin'),
    memberShare: size('fhe/members/member-0.bin'),
    input: size('input.bin'),
    result: size('result.bin'),
  },
  resultHandle: keccak256(bytesToHex(readFileSync(join(dir, 'result.bin')))),
  refusedUnderOtherMetadata: refusedElsewhere,
  decryption,
  bls: JSON.parse(readFileSync(join(dir, 'bls/public.json'), 'utf8')),
  signed,
  below,
  signRefusedBelowQuorum: bySignersFails,
  chain: {
    rpc: RPC_URL,
    block: head,
    hashToCurveEip2537: hEip2537,
    pairingAcceptsSigned: await pairing(signed.signatureEip2537),
    pairingAcceptsBelow: await pairing(below.signatureEip2537),
  },
}
rmSync(dir, { recursive: true, force: true })
mkdirSync(out, { recursive: true })
const path = join(out, `c1-${label}.json`)
writeFileSync(path, JSON.stringify(record, null, 2) + '\n')
console.log(`decrypted ${value}; precompile accepts the quorum's signature: ${record.chain.pairingAcceptsSigned}, two members': ${record.chain.pairingAcceptsBelow}`)
console.log(`recorded ${path}`)
