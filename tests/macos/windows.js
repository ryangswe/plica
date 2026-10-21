// Lists Plica's windows as "title<TAB>onscreen" lines (JXA; run with osascript -l JavaScript).
// Window titles need Screen Recording permission for the terminal running this.
ObjC.import('CoreGraphics');
function run() {
  const list = ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionAll, 0));
  const out = [];
  for (let i = 0; i < list.count; i++) {
    const w = list.objectAtIndex(i);
    if (ObjC.unwrap(w.objectForKey('kCGWindowOwnerName')) !== 'Plica') continue;
    if (ObjC.unwrap(w.objectForKey('kCGWindowLayer')) !== 0) continue;
    const title = ObjC.unwrap(w.objectForKey('kCGWindowName'));
    if (!title) continue;
    out.push(title + '\t' + (ObjC.unwrap(w.objectForKey('kCGWindowIsOnscreen')) ? 'on' : 'off'));
  }
  return out.sort().join('\n');
}
