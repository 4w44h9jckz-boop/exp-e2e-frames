import { H, treeOf } from '../15-x10-out-and-back/x10.js'
const leaves = [11n, 22n, 33n, 44n, 55n, 66n, 77n]
const t = treeOf(leaves)
for (const idx of [0, 3, 6]) {
  const p = t.path(idx)
  let node = leaves[idx]
  for (let l = 0; l < 20; l++) node = p.pathIndices[l] ? H(p.pathElements[l], node) : H(node, p.pathElements[l])
  console.log(idx, node === t.root, p.pathIndices.slice(0, 4).join(''))
}
process.exit(0)
