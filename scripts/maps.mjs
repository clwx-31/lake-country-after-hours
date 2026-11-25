// Map definitions shared by the fetch and convert scripts.
//   crop     bounds fetched and converted (S, W, N, E in degrees)
//   origin   fixed local origin, so coordinates never move if the crop grows
//   datum    elevation subtracted from every height (null = lowest ground - 2 m)
//   vscale   vertical exaggeration applied to the terrain (1 = real)
//   maxGrade steepest road grade allowed on ordinary roads
//   shelf    extra metres of level ground beside each road (one terrain cell on steep maps)
//   villages municipal boundaries kept for town styling and labels
export const MAPS = {
  lakecountry: {
    title: 'Chenequa and Hartland, Wisconsin',
    raw: 'data/raw-lake', file: 'lakecountry',
    crop: { s: 43.07, w: -88.407, n: 43.185, e: -88.28 },
    origin: { lat: 43.1115, lon: -88.3535 },
    datum: 256, vscale: 1, maxGrade: 0.14, shelf: 0,
    villages: ['Chenequa', 'Hartland', 'Merton', 'Delafield', 'Pewaukee'],
  },
  holyhill: {
    title: 'Holy Hill and the Kettle Moraine, Wisconsin',
    raw: 'data/raw-holyhill', file: 'holyhill',
    // Holy Hill, Friess Lake, Hubertus and the Kettle Moraine State Forest hills around them.
    crop: { s: 43.205, w: -88.375, n: 43.285, e: -88.245 },
    origin: { lat: 43.245, lon: -88.31 },
    // The exaggerated hills are steep: allow 20% grades on ordinary roads, and
    // level a wider shelf so no terrain triangle under the road rises through it.
    datum: null, vscale: 1.5, maxGrade: 0.2, shelf: 9,
    villages: ['Erin', 'Richfield', 'Hartford', 'Slinger', 'Merton', 'Lisbon'],
  },
};

export function mapArg(argv = process.argv) {
  const i = argv.indexOf('--map');
  const id = i >= 0 ? argv[i + 1] : 'lakecountry';
  if (!MAPS[id]) throw new Error(`unknown map ${id} (have ${Object.keys(MAPS).join(', ')})`);
  return { id, ...MAPS[id] };
}
