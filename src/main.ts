import './ui/style.css';
import { loadDistrict } from './map/District';
import { Game } from './game/Game';
import { chosenMap, selectMap } from './map/maps';

async function boot() {
  const boot = document.getElementById('boot')!;
  try {
    const map = selectMap(chosenMap());
    boot.textContent = map.loading;
    const district = await loadDistrict(new URL(`./data/${map.file}.json`, document.baseURI).href);
    await document.fonts.ready;
    const game = new Game(district, document.getElementById('view') as HTMLCanvasElement, document.getElementById('ui')!);
    (window as unknown as { __game: Game }).__game = game;
    boot.remove();
    game.start();
  } catch (err) {
    console.error(err);
    boot.classList.add('error');
    boot.textContent = `Could not start: ${(err as Error).message}`;
  }
}

boot();
