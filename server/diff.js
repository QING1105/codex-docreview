'use strict';
// 词级 diff：中日韩按字，拉丁按词，空白和标点各自成 token
function tokenize(s) { return s.match(/[A-Za-z0-9_]+|\s+|[\s\S]/gu) || []; }
function diff(a, b) {
  if (a === b) return a ? [{ t: 'eq', s: a }] : [];
  const A = tokenize(a), B = tokenize(b);
  let pre = 0; while (pre < A.length && pre < B.length && A[pre] === B[pre]) pre++;
  let suf = 0; while (suf < A.length - pre && suf < B.length - pre && A[A.length - 1 - suf] === B[B.length - 1 - suf]) suf++;
  const X = A.slice(pre, A.length - suf), Y = B.slice(pre, B.length - suf), n = X.length, m = Y.length;
  const out = []; const push = (t, s) => { if (!s) return; const l = out[out.length - 1]; if (l && l.t === t) l.s += s; else out.push({ t, s }); };
  push('eq', A.slice(0, pre).join(''));
  if (n * m > 4e6) { push('del', X.join('')); push('ins', Y.join('')); }
  else {
    const W = m + 1, L = new Uint32Array((n + 1) * W);
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i * W + j] = X[i] === Y[j] ? L[(i + 1) * W + j + 1] + 1 : Math.max(L[(i + 1) * W + j], L[i * W + j + 1]);
    let i = 0, j = 0;
    while (i < n && j < m) { if (X[i] === Y[j]) { push('eq', X[i]); i++; j++; } else if (L[(i + 1) * W + j] >= L[i * W + j + 1]) push('del', X[i++]); else push('ins', Y[j++]); }
    while (i < n) push('del', X[i++]); while (j < m) push('ins', Y[j++]);
  }
  push('eq', A.slice(A.length - suf).join(''));
  // 空格不作为替换短语的断点；分别保留旧稿和新稿的完整空白。
  const grouped = [];
  for (let i = 0; i < out.length;) {
    if (out[i].t === 'eq') { grouped.push(out[i++]); continue; }
    let oldText = '', newText = '';
    while (i < out.length) {
      const item = out[i];
      if (item.t === 'eq' && !(/^\s+$/.test(item.s) && out[i + 1] && out[i + 1].t !== 'eq')) break;
      if (item.t !== 'ins') oldText += item.s;
      if (item.t !== 'del') newText += item.s;
      i++;
    }
    if (oldText) grouped.push({ t: 'del', s: oldText });
    if (newText) grouped.push({ t: 'ins', s: newText });
  }
  return grouped;
}
module.exports = { diff };
