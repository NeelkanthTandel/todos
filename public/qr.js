// A small QR code encoder (byte mode, error correction level M, versions 1–40), so a pairing code can be
// scanned from another device without a library or a request anywhere. It follows the QR spec (ISO/IEC 18004)
// the way Project Nayuki's reference encoder lays it out. TodoQR.svg(text) returns an <svg> element.
(() => {
  // Per version (index 1–40), for level M: error correction codewords per block, and number of blocks.
  const ECC_PER_BLOCK = [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28];
  const BLOCKS = [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49];
  const ECL_BITS = 0; // M

  function rawModules(ver) {
    let n = (16 * ver + 128) * ver + 64;
    if (ver >= 2) {
      const align = Math.floor(ver / 7) + 2;
      n -= (25 * align - 10) * align - 55;
      if (ver >= 7) n -= 36;
    }
    return n;
  }
  const dataCodewords = ver => Math.floor(rawModules(ver) / 8) - ECC_PER_BLOCK[ver] * BLOCKS[ver];

  // Reed–Solomon over GF(2^8) with the polynomial 0x11D.
  function mul(x, y) {
    let z = 0;
    for (let i = 7; i >= 0; i--) {
      z = (z << 1) ^ ((z >>> 7) * 0x11d);
      z ^= ((y >>> i) & 1) * x;
    }
    return z & 0xff;
  }
  function divisor(degree) {
    const out = new Array(degree).fill(0);
    out[degree - 1] = 1;
    let root = 1;
    for (let i = 0; i < degree; i++) {
      for (let j = 0; j < out.length; j++) {
        out[j] = mul(out[j], root);
        if (j + 1 < out.length) out[j] ^= out[j + 1];
      }
      root = mul(root, 0x02);
    }
    return out;
  }
  function remainder(data, div) {
    const out = new Array(div.length).fill(0);
    for (const b of data) {
      const factor = b ^ out.shift();
      out.push(0);
      for (let i = 0; i < out.length; i++) out[i] ^= mul(div[i], factor);
    }
    return out;
  }

  function encode(text) {
    const bytes = new TextEncoder().encode(text);
    let ver = 1;
    for (; ver <= 40; ver++) if (4 + (ver <= 9 ? 8 : 16) + bytes.length * 8 <= dataCodewords(ver) * 8) break;
    if (ver > 40) throw new Error("too long for a QR code");
    const capacity = dataCodewords(ver) * 8;

    // Mode (byte), length, data, terminator, padding.
    const bits = [];
    const put = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
    put(4, 4); put(bytes.length, ver <= 9 ? 8 : 16);
    for (const b of bytes) put(b, 8);
    put(0, Math.min(4, capacity - bits.length));
    put(0, (8 - bits.length % 8) % 8);
    for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) put(pad, 8);
    const data = [];
    for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));

    // Split into blocks, add error correction, interleave.
    const nBlocks = BLOCKS[ver], eccLen = ECC_PER_BLOCK[ver], raw = Math.floor(rawModules(ver) / 8);
    const nShort = nBlocks - raw % nBlocks, shortLen = Math.floor(raw / nBlocks);
    const div = divisor(eccLen), blocks = [];
    for (let i = 0, k = 0; i < nBlocks; i++) {
      const dat = data.slice(k, k + shortLen - eccLen + (i < nShort ? 0 : 1));
      k += dat.length;
      const ecc = remainder(dat, div);
      if (i < nShort) dat.push(0);
      blocks.push(dat.concat(ecc));
    }
    const words = [];
    for (let i = 0; i < blocks[0].length; i++) {
      blocks.forEach((b, j) => { if (i !== shortLen - eccLen || j >= nShort) words.push(b[i]); });
    }
    return { ver, words };
  }

  function matrix(text) {
    const { ver, words } = encode(text);
    const size = ver * 4 + 17;
    const mods = Array.from({ length: size }, () => new Array(size).fill(false));
    const fixed = Array.from({ length: size }, () => new Array(size).fill(false));
    const set = (x, y, dark) => { mods[y][x] = dark; fixed[y][x] = true; };

    for (let i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); } // timing
    const finder = (cx, cy) => {
      for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx, y = cy + dy, d = Math.max(Math.abs(dx), Math.abs(dy));
        if (x >= 0 && x < size && y >= 0 && y < size) set(x, y, d !== 2 && d !== 4);
      }
    };
    finder(3, 3); finder(size - 4, 3); finder(3, size - 4);
    const align = [];
    if (ver > 1) {
      const n = Math.floor(ver / 7) + 2;
      const step = ver === 32 ? 26 : Math.ceil((ver * 4 + 4) / (n * 2 - 2)) * 2;
      align.push(6);
      for (let pos = size - 7; align.length < n; pos -= step) align.splice(1, 0, pos);
    }
    align.forEach((ay, i) => align.forEach((ax, j) => {
      if ((i === 0 && j === 0) || (i === 0 && j === align.length - 1) || (i === align.length - 1 && j === 0)) return;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(ax + dx, ay + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }));
    const format = mask => {
      const d = (ECL_BITS << 3) | mask;
      let rem = d;
      for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
      const b = ((d << 10) | rem) ^ 0x5412, bit = i => ((b >>> i) & 1) === 1;
      for (let i = 0; i <= 5; i++) set(8, i, bit(i));
      set(8, 7, bit(6)); set(8, 8, bit(7)); set(7, 8, bit(8));
      for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
      for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
      for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
      set(8, size - 8, true);
    };
    format(0); // reserves the format areas; redrawn once the mask is chosen
    if (ver >= 7) {
      let rem = ver;
      for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
      const b = (ver << 12) | rem;
      for (let i = 0; i < 18; i++) {
        const dark = ((b >>> i) & 1) === 1, a = size - 11 + i % 3, c = Math.floor(i / 3);
        set(a, c, dark); set(c, a, dark);
      }
    }

    // Data, in the zigzag order.
    let i = 0;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let v = 0; v < size; v++) for (let j = 0; j < 2; j++) {
        const x = right - j, up = ((right + 1) & 2) === 0, y = up ? size - 1 - v : v;
        if (!fixed[y][x] && i < words.length * 8) { mods[y][x] = ((words[i >>> 3] >>> (7 - (i & 7))) & 1) === 1; i++; }
      }
    }

    const MASKS = [
      (x, y) => (x + y) % 2 === 0, (x, y) => y % 2 === 0, x => x % 3 === 0, (x, y) => (x + y) % 3 === 0,
      (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0, (x, y) => (x * y) % 2 + (x * y) % 3 === 0,
      (x, y) => ((x * y) % 2 + (x * y) % 3) % 2 === 0, (x, y) => ((x + y) % 2 + (x * y) % 3) % 2 === 0,
    ];
    const applyMask = m => {
      for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!fixed[y][x] && MASKS[m](x, y)) mods[y][x] = !mods[y][x];
    };
    let best = 0, bestScore = Infinity;
    for (let m = 0; m < 8; m++) {
      applyMask(m); format(m);
      const s = penalty(mods, size);
      if (s < bestScore) { best = m; bestScore = s; }
      applyMask(m); // XOR again undoes it
    }
    applyMask(best); format(best);
    return { size, version: ver, mask: best, dark: (x, y) => mods[y][x] };
  }

  // The spec's four penalty rules, used to pick the mask that scans best.
  function penalty(m, size) {
    let score = 0, dark = 0;
    const line = get => {
      let run = 1;
      for (let i = 1; i <= size; i++) {
        if (i < size && get(i) === get(i - 1)) run++;
        else { if (run >= 5) score += run - 2; run = 1; }
      }
      // 1:1:3:1:1 finder-like patterns with four light modules on either side.
      for (let i = 0; i + 11 <= size; i++) {
        const p = [1, 0, 1, 1, 1, 0, 1];
        const core = p.every((v, k) => get(i + k + 4) === !!v) && [0, 1, 2, 3].every(k => !get(i + k));
        const core2 = p.every((v, k) => get(i + k) === !!v) && [7, 8, 9, 10].every(k => !get(i + k));
        if (core) score += 40;
        if (core2) score += 40;
      }
    };
    for (let y = 0; y < size; y++) line(x => m[y][x]);
    for (let x = 0; x < size; x++) line(y => m[y][x]);
    for (let y = 0; y + 1 < size; y++) for (let x = 0; x + 1 < size; x++) {
      const c = m[y][x];
      if (c === m[y][x + 1] && c === m[y + 1][x] && c === m[y + 1][x + 1]) score += 3;
    }
    for (const row of m) for (const c of row) if (c) dark++;
    const total = size * size;
    score += Math.max(0, Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
    return score;
  }

  // An <svg> of the code with the quiet zone round it, dark modules as one path.
  function svg(text) {
    const q = matrix(text), NS = "http://www.w3.org/2000/svg", border = 4;
    let d = "";
    for (let y = 0; y < q.size; y++) for (let x = 0; x < q.size; x++) if (q.dark(x, y)) d += "M" + (x + border) + "," + (y + border) + "h1v1h-1z";
    const el = document.createElementNS(NS, "svg");
    const full = q.size + border * 2;
    el.setAttribute("viewBox", "0 0 " + full + " " + full);
    el.setAttribute("shape-rendering", "crispEdges");
    const bg = document.createElementNS(NS, "rect");
    bg.setAttribute("width", full); bg.setAttribute("height", full); bg.setAttribute("fill", "#fff");
    const path = document.createElementNS(NS, "path");
    path.setAttribute("d", d); path.setAttribute("fill", "#000");
    el.append(bg, path);
    return el;
  }

  window.TodoQR = { matrix, svg };
})();
