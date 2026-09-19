export class Cache {
    constructor(name = 'folio-cache-v1') { this.name = name; this.opened = null; }
    open() {
        if (!this.opened) this.opened = new Promise((resolve, reject) => {
            const r = indexedDB.open(this.name, 1);
            r.onupgradeneeded = () => {
                for (const store of ['records', 'vectors', 'leases']) r.result.createObjectStore(store);
            };
            r.onsuccess = () => resolve(r.result);
            r.onerror = () => reject(new Error('瀏覽器記憶快取無法開啟'));
            r.onblocked = () => reject(new Error('另一個視窗正在更新記憶快取'));
        }).catch(e => { this.opened = null; throw e; });
        return this.opened;
    }
    async get(store, key) {
        const db = await this.open();
        return new Promise((resolve, reject) => {
            const req = db.transaction(store).objectStore(store).get(key);
            req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error);
        });
    }
    async put(store, key, value) {
        const db = await this.open();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(store, 'readwrite'); tx.objectStore(store).put(value, key);
            tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error ?? new Error('快取交易中止'));
        });
    }
    async lease(key, owner, release = false) {
        const db = await this.open();
        return new Promise((resolve, reject) => {
            const tx = db.transaction('leases', 'readwrite'), table = tx.objectStore('leases');
            let acquired = false;
            const r = table.get(key);
            r.onsuccess = () => {
                const old = r.result;
                if (release) { if (old?.owner === owner) table.delete(key); return; }
                if (!old || old.owner === owner || old.until < Date.now()) {
                    table.put({owner, until:Date.now() + 90000}, key); acquired = true;
                }
            };
            tx.oncomplete = () => resolve(acquired);
            tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error ?? new Error('記憶鎖交易中止'));
        });
    }
    async pruneRecords(identity,hashes) {
        const db=await this.open(),prefix=identity+':',keep=new Set(hashes);
        return new Promise((resolve,reject)=>{
            const tx=db.transaction('records','readwrite'),request=tx.objectStore('records').openCursor();
            request.onsuccess=()=>{const cursor=request.result;if(!cursor)return;const key=String(cursor.key);
                if(key.startsWith(prefix)&&!keep.has(key.slice(prefix.length)))cursor.delete();cursor.continue();};
            tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error??new Error('記憶清理中止'));
        });
    }
    close() { this.opened?.then(db => db.close()).catch(() => {}); this.opened = null; }
}
