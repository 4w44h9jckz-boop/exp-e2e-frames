// Experiment 28: score a run against the predictions. Reads the run record and the inputs, and
// writes results/<run>-scored.json and prints the table the README quotes.
//
// Usage: npx tsx verify.ts results/1-first-run.json inputs
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { type Hex, concatHex, keccak256, recoverAddress, toRlp } from 'viem'

const [runFile, inputs] = process.argv.slice(2)
const run = JSON.parse(readFileSync(runFile, 'utf8'))
const input: Record<string, any> = {}
for (const set of readdirSync(inputs)) for (const f of readdirSync(`${inputs}/${set}`)) {
  const v = JSON.parse(readFileSync(`${inputs}/${set}/${f}`, 'utf8'))
  input[`${v.set}/${v.name}`] = v
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
const clean = (s: string) => s.replace(/\s+/g, '')

// The data each frame shows, rebuilt from its pages: the first page's text after "data (bytes)", then
// every following page of the same prompt, up to the page that repeats the title.
function shownData(screens: any[]): string[] {
  const out: string[] = []
  for (let i = 0; i < screens.length; i++) {
    const s = screens[i]
    if (s.prompt !== 'confirm_typed_value' || !s.text.startsWith('data (bytes)') || s.page !== 1) continue
    let hex = clean(s.text.slice('data (bytes)'.length))
    for (let j = i + 1; j < i + s.pages && j < screens.length; j++) {
      if (screens[j].text === screens[j].title) break
      hex += clean(screens[j].text)
    }
    out.push(hex)
  }
  return out
}

const rows: any[] = []
for (const v of run.vectors) {
  const inp = input[`${v.set}/${v.name}`]
  const frames = inp.typedData.message.frames
  const row: any = { set: v.set, name: v.name, frames: frames.length }
  for (const mode of ['full', 'short'] as const) {
    const r = v[mode]
    row[`${mode}_signed`] = r.signed
    row[`${mode}_screens`] = r.screen_count
    if (r.signed) {
      const signer = await recoverAddress({ hash: v.executionDigest as Hex, signature: r.signature as Hex })
      row[`${mode}_recovers`] = same(signer, run.address)
    } else row[`${mode}_refusal`] = r.refusal ?? r.error
  }
  const full = v.full.screens
  const domain = full.filter((s: any) => s.title === 'EIP712Domain').map((s: any) => s.text).join(' ')
  row.domain_shown = ['name (string)', 'version (string)', 'chainId (uint256)', 'verifyingContract (address)'].every((k) => domain.includes(k))
  const count = (label: string) => full.filter((s: any) => s.prompt === 'confirm_typed_value' && s.page === 1 && s.text.startsWith(label)).length
  row.frame_fields_shown = ['mode (uint8)', 'flags (uint8)', 'target (address)', 'executionLimit (uint64)', 'stateLimit (uint64)', 'value (uint256)', 'data (bytes)'].every((k) => count(k) === frames.length)
  const shown = shownData(full)
  row.data_exact = shown.length === frames.length && shown.every((h, i) => same(h, frames[i].data.replace(/^0x/, '')))
  const short = v.short.screens
  row.short_shows_a_frame = short.some((s: any) => /target \(address\)|value \(uint256\)|data \(bytes\)/.test(s.text))
  rows.push(row)
}

const auth: any[] = []
for (const d of run.delegates) {
  const row: any = { case: d.case, chain_id: d.chain_id, delegate: d.delegate, signed: d.signed, refusal: d.refusal ?? d.error ?? null, screens: d.screen_count }
  if (d.signed && d.auth_tuples?.length) {
    const [chain, delegate, nonce, yParity, r, s] = d.auth_tuples[0].map((x: string) => `0x${x}` as Hex)
    const digest = keccak256(concatHex(['0x05', toRlp([chain === '0x' ? '0x' : chain, delegate, nonce === '0x' ? '0x' : nonce])]))
    const v = BigInt(yParity === '0x' ? 0 : yParity) + 27n
    const signer = await recoverAddress({ hash: digest, signature: concatHex([r.padStart(66, '0').replace(/^0+x?/, '0x') as Hex, s as Hex, `0x${v.toString(16)}`]) })
    row.auth_nonce = BigInt(nonce === '0x' ? 0 : nonce).toString()
    row.auth_recovers = same(signer, run.address)
  }
  row.screen_titles = [...new Set(d.screens.map((s: any) => s.title))]
  auth.push(row)
}

const scored = { run: runFile, firmware: run.firmware, model: run.model, layout: run.layout, address: run.address, vectors: rows, delegates: auth }
writeFileSync(runFile.replace(/\.json$/, '-scored.json'), `${JSON.stringify(scored, null, 1)}\n`)
console.table(rows.map((r) => ({ set: r.set.replace('eip8250-', ''), name: r.name, frames: r.frames, full: `${r.full_signed ? 'signed' : 'REFUSED'} ${r.full_screens}`, short: `${r.short_signed ? 'signed' : 'REFUSED'} ${r.short_screens}`, recovers: `${r.full_recovers}/${r.short_recovers}`, domain: r.domain_shown, fields: r.frame_fields_shown, dataExact: r.data_exact, shortShowsFrame: r.short_shows_a_frame })))
console.table(auth.map((a) => ({ case: a.case, chain: a.chain_id, delegate: a.delegate.slice(0, 10), signed: a.signed, refusal: a.refusal, authNonce: a.auth_nonce, recovers: a.auth_recovers, screens: a.screens })))
