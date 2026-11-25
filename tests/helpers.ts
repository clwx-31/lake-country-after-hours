import fs from 'node:fs';
import { District, decodeTerrain, type DistrictData } from '../src/map/District';
import { Terrain } from '../src/map/Terrain';

const cached = new Map<string, District>();
/** A map's district with its real terrain heightfield (Lake Country by default). */
export function loadTestDistrict(map = 'lakecountry') {
  let d = cached.get(map);
  if (!d) {
    const data = JSON.parse(fs.readFileSync(`public/data/${map}.json`, 'utf8')) as DistrictData;
    const terrain = Terrain.fromBuffer(data.terrain!, decodeTerrain(JSON.parse(fs.readFileSync(`public/data/${data.terrain!.file}`, 'utf8'))));
    d = new District(data, terrain);
    cached.set(map, d);
  }
  return d;
}
