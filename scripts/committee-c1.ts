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
// Every bls-committee call writes its JSON even when it refuses; the exit status says whether it
// made a signature.
const sign = async (sub: string, signers: string, file: string, v = value, extra: string[] = []) => {
  const ok = await run(bls_, [sub, '--dir', join(dir, 'bls'), '--signers', signers, '--chain-id', `${CHAIN_ID}`, '--request', request,
    '--ciphertext', join(dir, 'result.bin'), '--value', `${v}`, '--out', join(dir, file), ...extra], { cwd: dir }).then(() => true, () => false)
  return { exitOk: ok, ...JSON.parse(readFileSync(join(dir, file), 'utf8')) }
}
const signed = await sign('sign', '0,1,2', 'signed.json')
// A second result for the same request: every member asked, then with member 0 corrupted.
const secondResult = await sign('sign', '0,1,2,3', 'second.json', value + 1)
const secondResultCorrupt = await sign('sign', '0,1,2,3', 'second-corrupt.json', value + 1, ['--ignore-lock', '0'])
const below = await sign('sign-below', '0,1', 'below.json')
const bySignersFails = !(await sign('sign', '0,1', 'x.json', value, [])).exitOk
// t = 1 member, and q - 1 = 2 members, each with their share and the DKG's public output.
const forgeT = await sign('forge', '3', 'forge-t.json')
const forgeQ1 = await sign('forge', '0,1', 'forge-q1.json')

// The chain's EIP-2537 pairing precompile (0x0f): e(sigma, -g2) e(H(m), PK) = 1, H(m) hashed
// here with noble as Commonware hashes it: union_unique(namespace, message) under the POP DST.
const DST = 'BLS_SIG_BLS12381G1_XMD:SHA-256_SSWU_RO_POP_'
const NEG_G2 = '0x00000000000000000000000000000000024aa2b2f08f0a91260805272dc51051c6e47ad4fa403b02b4510b647ae3d1770bac0326a805bbefd48056c8c121bdb80000000000000000000000000000000013e02b6052719f607dacd3a088274f65596bd0d09920b61ab5da61bbdc7f5049334cf11213945d57e5ac7d055d042b7e000000000000000000000000000000000d1b3cc2c7027888be51d9ef691d77bcb679afda66c73f17f9ee3837a55024f78c71363275a75d75d86bab79f74782aa0000000000000000000000000000000013fa4d4a0ad8b1ce186ed5061789213d993923066dddaf1040bc3ff59f825c78df74f2d75467e25e0f55f8a00fa030ed'
const ns = hexToBytes(stringToHex(signed.namespace))
const h = bls.G1.hashToCurve(new Uint8Array([ns.length, ...ns, ...hexToBytes(signed.message)]), { DST }).toAffine()
const fp = (x: bigint) => numberToHex(x, { size: 64 })
const hEip2537 = concatHex([fp(h.x), fp(h.y)])
const head = Number.parseInt(await rpc('eth_blockNumber', []), 16)
const hashOf = (message: Hex) => {
  const p = bls.G1.hashToCurve(new Uint8Array([ns.length, ...ns, ...hexToBytes(message)]), { DST }).toAffine()
  return concatHex([fp(p.x), fp(p.y)])
}
const pairing = async (sig: Hex, hm: Hex = hEip2537) =>
  BigInt(await rpc('eth_call', [{ to: '0x000000000000000000000000000000000000000f', data: concatHex([sig, NEG_G2, hm, signed.keyEip2537]) }, numberToHex(head)])) === 1n
// The quorum's signature presented for another request: same result, same value.
const otherRequest = keccak256(stringToHex('C1: a request this result was not made for'))
const otherMessage = concatHex([numberToHex(CHAIN_ID, { size: 32 }), otherRequest, signed.handle, numberToHex(signed.value, { size: 32 })])

const size = (f: string) => statSync(join(dir, f)).size
const record = {
  entry: 'C1',
  label,
  ranAt: new Date().toISOString(),
  repoCommit,
  pins: JSON.parse(readFileSync(join(COMMITTEE_DIR, 'pins.json'), 'utf8')),
  network: 'every member in one process on one 4-core machine, in memory: a LAN time at best',
  whoSeesPartials: 'the process that combines them: here the command line, which every member hands its partial; they are not published',
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
  secondResult,
  secondResultCorrupt,
  forgeT,
  forgeQ1,
  budget: {
    nodes: 500_000,
    eip8141PublicMempool: 100_000,
    pairingAlone: 37_700 + 2 * 32_600,
    note: 'derived from EIP-2537 prices: the check is the ticket paymaster\'s, 122,006 gas of execution in experiment 04; no BLS check fits 100,000',
  },
  chain: {
    rpc: RPC_URL,
    block: head,
    hashToCurveEip2537: hEip2537,
    pairingAcceptsSigned: await pairing(signed.signatureEip2537),
    pairingAcceptsBelow: await pairing(below.signatureEip2537),
    otherRequest,
    otherMessage,
    pairingAcceptsForOtherRequest: await pairing(signed.signatureEip2537, hashOf(otherMessage)),
    pairingAcceptsForged: await Promise.all([...forgeT.attempts, ...forgeQ1.attempts].map((a: { signatureEip2537: Hex }) => pairing(a.signatureEip2537))),
  },
  shape: 'a rebuilt role: Fhenix\'s CoFHE node is not public; the coprocessor and the committee follow its documentation over tfhe-rs and threshold-fhe, unmodified. This tests the shape, not the product',
}
rmSync(dir, { recursive: true, force: true })
mkdirSync(out, { recursive: true })
const path = join(out, `c1-${label}.json`)
writeFileSync(path, JSON.stringify(record, null, 2) + '\n')
console.log(`decrypted ${value}; precompile accepts the quorum's signature: ${record.chain.pairingAcceptsSigned}, two members': ${record.chain.pairingAcceptsBelow}`)
console.log(`recorded ${path}`)
