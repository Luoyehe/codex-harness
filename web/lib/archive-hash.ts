// Incremental SHA-256 (FIPS 180-4). Archive parts are also retained by Blob;
// hashing them as they arrive avoids allocating a second contiguous archive.
const constants = Uint32Array.from([
  0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
  0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
  0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
  0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
  0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
  0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
  0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
  0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2,
]);
const rotate = (word: number, count: number) => (word >>> count) | (word << (32 - count));
export class ArchiveHash {
  private state = Uint32Array.from([0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]);
  private block = new Uint8Array(64);
  private words = new Uint32Array(64);
  private used = 0;
  private bytes = 0;
  private compress(block: Uint8Array) {
    const w = this.words, view = new DataView(block.buffer, block.byteOffset, 64);
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(i * 4);
    for (let i = 16; i < 64; i++) {
      const x = w[i-15]!, y = w[i-2]!;
      w[i] = w[i-16]! + (rotate(x,7) ^ rotate(x,18) ^ (x>>>3)) + w[i-7]! + (rotate(y,17) ^ rotate(y,19) ^ (y>>>10));
    }
    let a=this.state[0]!, b=this.state[1]!, c=this.state[2]!, d=this.state[3]!,
      e=this.state[4]!, f=this.state[5]!, g=this.state[6]!, h=this.state[7]!;
    for (let i=0;i<64;i++) {
      const sum=h + (rotate(e,6)^rotate(e,11)^rotate(e,25)) + ((e&f)^(~e&g)) + constants[i]! + w[i]!;
      const other=(rotate(a,2)^rotate(a,13)^rotate(a,22)) + ((a&b)^(a&c)^(b&c));
      h=g; g=f; f=e; e=(d+sum)>>>0; d=c; c=b; b=a; a=(sum+other)>>>0;
    }
    this.state[0]!+=a; this.state[1]!+=b; this.state[2]!+=c; this.state[3]!+=d;
    this.state[4]!+=e; this.state[5]!+=f; this.state[6]!+=g; this.state[7]!+=h;
  }
  update(input: Uint8Array) {
    this.bytes += input.length;
    let pos = 0;
    while (pos < input.length) {
      if (this.used === 0 && input.length-pos >= 64) {
        this.compress(input.subarray(pos,pos+64)); pos += 64; continue;
      }
      const count = Math.min(64-this.used,input.length-pos);
      this.block.set(input.subarray(pos,pos+count),this.used);
      pos += count; this.used += count;
      if (this.used === 64) { this.compress(this.block); this.used=0; }
    }
  }
  finish(): string {
    this.block[this.used++] = 0x80;
    this.block.fill(0,this.used);
    if (this.used > 56) { this.compress(this.block); this.block.fill(0); }
    new DataView(this.block.buffer).setBigUint64(56, BigInt(this.bytes)*8n);
    this.compress(this.block);
    return Array.from(this.state, word => word.toString(16).padStart(8,'0')).join('');
  }
}
