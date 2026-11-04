import * as L from './lean.js'
const rnd = () => crypto.getRandomValues(new Uint8Array(32))
const leaves = Array.from({ length: 5 }, rnd)
const ns = rnd(), s = rnd()
leaves[3] = L.leafOf(ns, s)
const b = L.v5(ns, s, rnd(), L.treeOf(leaves), 3)
try { console.log('v5', JSON.stringify(L.prove('v5_tornado', b.input, 1))) } catch (e) { console.log('v5 failed', (e as { stderr?: string }).stderr?.split('\n').filter((l) => /panicked|Error|error|expect/.test(l)).slice(0, 6).join(' | ')) }
