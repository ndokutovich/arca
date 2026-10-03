---
description: Diagnose and shrink the vault's git store when it outgrows the archive
argument-hint: [--diagnose | --repack]
---

# Vault maintenance

The vault keeps every version of every transcript, so its `.git` is always
larger than the working tree. The question is by how much. On 2026-10-03 it was
241 GB against 8.3 GB of tree, and the cause was a single session.

## 1. Diagnose first, always

```bash
cd ~/.claude-vault
git count-objects -vH      # count / size (loose) / in-pack / size-pack / garbage
du -sh .git .              # the store against the tree
df -h /c                   # room to work in
```

Read it like this:

- **`garbage` above zero** — leftovers of an interrupted `gc`/`repack`. Free
  space, delete them, no questions: `.git/objects/*/tmp_obj_*` and
  `pack/tmp_pack_*`. One interrupted run left 278 files and 39.8 GB.
- **`size` (loose) in the tens of GB** — objects written since the last repack.
  Loose objects are never delta-compressed, so this is where the bloat lives.
- **`size-pack` close to `size`** — nothing is compressing, which means the
  objects are too big to delta. See below.

Find what the loose weight actually is before touching anything:

```bash
# the largest loose objects, and which session each belongs to
find .git/objects -type f -not -path '*/pack/*' -printf '%s %p\n' | sort -rn | head -20
```

An object larger than 512 MB is stored whole on every change, because
`core.bigFileThreshold` defaults to `512m` and git does not deltify above it.
A transcript that grows past that size is paid for in full, every commit. On
2026-10-03, 580 versions of one 892 MB session were 138 GB of a 150 GB problem.

## 2. Measure the payoff before repacking

Never start a repack of hundreds of GB on faith. Pack a sample and look:

```bash
LIST=$(find .git/objects -type f -not -path '*/pack/*' -size +50M -printf '%h/%f\n' \
  | sed 's|.git/objects/||; s|/||' | head -12)
printf '%s\n' $LIST | git pack-objects --stdout > /dev/null            # as configured now
printf '%s\n' $LIST | git -c core.bigFileThreshold=2g pack-objects --stdout > /tmp/p.pack
ls -l /tmp/p.pack
```

A growing transcript is its previous self plus a tail, so deltas are nearly
free: twelve versions spread across the whole range came to 260 MB, the size of
*one*. If the sample does not shrink, stop — the repack would only rewrite the
same bytes.

## 3. Repack in batches

Write this to a temp file and run it in the background. It is resumable: the
list is rebuilt each run from what is still loose, and packed objects are pruned
as it goes, so a run stopped by memory or a time limit is simply started again.

```bash
#!/usr/bin/env bash
set -u
cd "$HOME/.claude-vault" || exit 1
T="$(cygpath -m "$TEMP")"
BATCH="${BATCH:-15}"; MIN_MB="${MIN_MB:-50}"; WINDOW="${WINDOW:-5}"; DEPTH="${DEPTH:-5}"

LOCK="$T/repack-vault.lock"
mkdir "$LOCK" 2>/dev/null || { echo "already running — rmdir '$LOCK'"; exit 1; }
trap 'rmdir "$LOCK" 2>/dev/null' EXIT

LIST="$T/shlist-$$.txt"
node -e '
const fs=require("fs"); const min=Number(process.argv[2])*1048576; const rows=[];
for(const d of fs.readdirSync(".git/objects").filter(x=>/^[0-9a-f]{2}$/.test(x)))
  for(const f of fs.readdirSync(".git/objects/"+d)) {
    if(f.length!==38) continue;
    const st=fs.statSync(".git/objects/"+d+"/"+f);
    if(st.size >= min) rows.push({sha:d+f,size:st.size});
  }
rows.sort((a,b)=>a.size-b.size);            // versions of one file end up adjacent
// No trailing newline for an empty list: `wc -l` would count it as one object
// and the loop would hand git a blank name.
fs.writeFileSync(process.argv[1], rows.length ? rows.map(r=>r.sha).join("\n")+"\n" : "");
console.log("objects:", rows.length);
' "$LIST" "$MIN_MB"

total=$(wc -l < "$LIST")
if [ "$total" -eq 0 ]; then echo "nothing to pack"; exit 0; fi
batches=$(( (total + BATCH - 1) / BATCH )); echo "batches: $batches x $BATCH"

for ((i=0; i<batches; i++)); do
  sed -n "$((i*BATCH+1)),$(((i+1)*BATCH))p" "$LIST" > "$T/b$$.txt"
  git -c core.bigFileThreshold=2g -c pack.windowMemory=256m \
      pack-objects --stdout --window="$WINDOW" --depth="$DEPTH" --threads=1 \
      < "$T/b$$.txt" > "$T/b$$.pack" 2> "$T/b$$.err" || { echo "batch $((i+1)) failed"; exit 1; }
  git index-pack --stdin < "$T/b$$.pack" > /dev/null 2>&1 || { echo "index-pack refused batch $((i+1))"; rm -f "$T/b$$.pack"; exit 1; }
  git prune-packed > /dev/null 2>&1
  printf 'batch %d/%d: pack %.1f MB, loose %s, free %s\n' "$((i+1))" "$batches" \
    "$(stat -c %s "$T/b$$.pack" | awk '{print $1/1048576}')" \
    "$(find .git/objects -type f -not -path '*/pack/*' | wc -l)" \
    "$(df -h /c | tail -1 | awk '{print $4}')"
  rm -f "$T/b$$.pack" "$T/b$$.txt"
done
echo DONE
```

Two passes, both worth running:

1. `MIN_MB=50 BATCH=15 WINDOW=5` — the oversized objects. Small batches because
   each object is up to 892 MB and a wide delta window on those exhausts RAM.
2. `MIN_MB=0 BATCH=2000 WINDOW=50 DEPTH=50` — everything left. On small objects
   the deep window is cheap and compresses better.

## 4. Verify

```bash
git fsck --connectivity-only          # only "dangling blob" lines are normal
git count-objects -vH                 # garbage 0, loose ~0
du -sh .git .
```

Then delete any `garbage` the run itself left behind and check once more.

## Traps, all of them met

- **A background job stopped by the harness kills only the tool's shell.** The
  script forks for `$(...)` and keeps running. Two runs at once shared
  `batch.pack` and wrecked each other's work. Hence the pid in every temp name
  and the `mkdir` lock.
- **`pack.windowMemory=1g` on 892 MB objects exhausts 32 GB of RAM.** Use 128m
  or 256m and a window of 5.
- **An interrupted `index-pack` leaves `pack/tmp_pack_*`.** Harmless, unreferenced,
  delete them.
- **A full `git repack -a -d` needs room for the whole new pack at once.** With
  the store at 200 GB and 60 GB free it cannot finish. Batches free space as
  they go, which is why they are the method here.
- **Do not delete `.git` and re-init.** It frees the same space and costs every
  previous version of every transcript, plus the commit timeline — and it is the
  only irreversible move on this list.

## Reference: the 2026-10-03 run

`.git` 241 → 60 GB, loose 150 GiB → 69 MiB, 41 packs, whole vault 249 → 68 GB,
free space 26 → 195 GB, 3138 commits intact, `fsck` clean.

## Not done, and why

The growth returns: any transcript past 512 MB is committed whole on each change
again. Two cures are possible.

- **Keep `core.bigFileThreshold` raised** (say 2g). One config line; it makes
  the blobs deltifiable so the next repack shrinks them. It does not stop the
  full copy being written.
- **Chunk large transcripts in the vault** — split at, say, 48 MB and teach
  `restore` to reassemble. Then a change rewrites one chunk, deltas work, and
  the file limit can go back to the default. This is the real cure and needs a
  transparent split/join that `restore` reverses exactly; until that exists the
  archive stays as it is.
