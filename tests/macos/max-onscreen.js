// Prints the most Plica windows seen on screen at once over N ms (JXA; osascript -l JavaScript max-onscreen.js 4000).
// Tabs that aren't selected are off screen, so a batch opened as tabs should never show more than one.
ObjC.import('CoreGraphics');
function onscreen() {
  const list = ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly, 0));
  let n = 0;
  for (let i = 0; i < list.count; i++) {
    const w = list.objectAtIndex(i);
    if (ObjC.unwrap(w.objectForKey('kCGWindowOwnerName')) === 'Plica' && ObjC.unwrap(w.objectForKey('kCGWindowLayer')) === 0) n++;
  }
  return n;
}
function run(argv) {
  const end = Date.now() + Number(argv[0] || 4000);
  let max = 0;
  while (Date.now() < end) { max = Math.max(max, onscreen()); delay(0.02); }
  return String(max);
}
