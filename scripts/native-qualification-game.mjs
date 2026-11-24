// Deterministic project files returned by the scripted provider. The installed
// harness writes them only after AI-DLC has issued its code-generation step.
export const starterGame = `<!doctype html><title>Catch the target</title>
<button id="target">Catch</button><output>0</output>
<script>document.querySelector('button').onclick = event => {
  document.querySelector('output').value = Number(document.querySelector('output').value) + 1;
  event.target.style.transform = 'translateX(' + Math.round(Math.random() * 200) + 'px)';
};</script>
`;
export const gameModule = `export function nextTarget(score) {
  return { x: (score * 47) % 220 - 100, y: (score * 29) % 140 - 60, z: (score * 61) % 240 - 120 };
}
`;
export const gamePage = `<!doctype html><html lang="en"><title>Catch the 3D target</title>
<style>main { perspective: 420px; width: 400px; height: 240px; display: grid; place-items: center; background: #dceafa }
button { transform-style: preserve-3d; box-shadow: 0 5px 0 #284860 }</style>
<h1>Catch the 3D target</h1><p>Click the target as it moves through depth. Score <output>0</output></p>
<main><button>Catch</button></main><script type="module">
import {nextTarget} from './game.mjs';
const button = document.querySelector('button'), score = document.querySelector('output');
button.onclick = () => { score.value = Number(score.value) + 1; const {x,y,z} = nextTarget(Number(score.value));
  button.style.transform = 'translate3d(' + x + 'px,' + y + 'px,' + z + 'px)'; };
</script></html>
`;
export const gameTest = `import {test} from 'node:test';
import assert from 'node:assert/strict';
import {nextTarget} from './game.mjs';
test('scoring moves the target along three axes', () => {
  assert.deepEqual(nextTarget(1), {x:-53, y:-31, z:-59});
  assert.notEqual(nextTarget(2).z, nextTarget(1).z);
});
`;
