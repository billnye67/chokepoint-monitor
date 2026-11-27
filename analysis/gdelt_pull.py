# Pull GDELT 1.0 daily event files and keep events located at the two test areas. Raw rows saved as JSON lines.
import sys, io, re, json, zipfile, urllib.request, datetime, concurrent.futures as cf
OUT = sys.argv[1]
AREAS = {
  "hormuz": (re.compile(r"Hormuz|Bandar Abbas|Bandar-e Abbas|Qeshm|Musandam|Khasab|Hormozgan|Fujairah|Larak|Gulf of Oman|Persian Gulf", re.I), "2026-06-15", "2026-07-13"),
  "bosporus": (re.compile(r"Bosporus|Bosphorus|Dardanelles|Sea of Marmara|Black Sea|Novorossiysk|Odesa|Odessa|Chornomorsk|Constanta|Tuapse|Kerch|Sevastopol|Pivdennyi|Yuzhny|Izmail|Taman", re.I), "2026-06-01", "2026-11-22"),
}
def days(a, b):
    d = datetime.date.fromisoformat(a)
    while d <= datetime.date.fromisoformat(b):
        yield d; d += datetime.timedelta(days=1)
want = {}
for name, (rx, a, b) in AREAS.items():
    for d in days(a, b): want.setdefault(d, []).append(name)
def one(d):
    url = "https://data.gdeltproject.org/events/%s.export.CSV.zip" % d.strftime("%Y%m%d")
    for attempt in range(3):
        try:
            raw = urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "research-client"}), timeout=120).read()
            z = zipfile.ZipFile(io.BytesIO(raw)); rows = []; total = 0
            for line in z.read(z.namelist()[0]).decode("utf-8", "replace").split("\n"):
                c = line.split("\t")
                if len(c) < 58: continue
                total += 1
                for name in want[d]:
                    if AREAS[name][0].search(c[50]):
                        rows.append({"area": name, "file_day": d.isoformat(), "event_day": c[1], "actor1": c[6], "actor2": c[16], "code": c[26], "root": c[28], "quad": c[29],
                                     "goldstein": c[30], "mentions": int(c[31] or 0), "sources": int(c[32] or 0), "articles": int(c[33] or 0), "tone": c[34], "place": c[50], "url": c[57].strip()})
            return d, total, rows, None
        except Exception as e: err = str(e)
    return d, 0, [], err
with open(OUT, "w", encoding="utf-8") as out, cf.ThreadPoolExecutor(6) as ex:
    n = 0
    for d, total, rows, err in ex.map(one, sorted(want)):
        n += 1
        for r in rows: out.write(json.dumps(r) + "\n")
        out.flush()
        print(d, "events", total, "kept", len(rows), err or "", flush=True)
print("DONE", n)
