export class WordPiece {
    constructor(text) {
        this.vocab = new Map(text.replace(/\r/g, '').split('\n').map((word, i) => [word, i]));
        for (const token of ['[CLS]', '[SEP]', '[UNK]', '[PAD]']) if (!this.vocab.has(token)) throw new Error('內建詞表損壞');
    }
    encode(text, max = 512) {
        const s = String(text).normalize('NFD').toLowerCase().replace(/\p{M}/gu, '');
        const tokens = s.match(/[\p{Script=Han}]|[\p{L}\p{N}]+|[^\s\p{C}]/gu) ?? [];
        const ids = [this.vocab.get('[CLS]')];
        for (const token of tokens) {
            if (ids.length >= max - 1) break;
            if (token.length > 100) { ids.push(this.vocab.get('[UNK]')); continue; }
            const pieces = []; let start = 0, bad = false;
            while (start < token.length) {
                let end = token.length, id;
                while (end > start) {
                    id = this.vocab.get((start ? '##' : '') + token.slice(start, end));
                    if (id !== undefined) break;
                    end--;
                }
                if (id === undefined) { bad = true; break; }
                pieces.push(id); start = end;
            }
            ids.push(...(bad ? [this.vocab.get('[UNK]')] : pieces));
        }
        return [...ids.slice(0, max - 1), this.vocab.get('[SEP]')];
    }
}
