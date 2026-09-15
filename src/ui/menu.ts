import { LEVELS } from '../sim/levels.ts';
import { MAPS } from '../sim/plans.ts';
import { type LevelDef, defineLevel } from '../sim/world/level-data.ts';
import { forgetLevel, savedLevels } from '../library.ts';

/**
 * The thing you see first: which contract, and whether you are taking it or
 * watching somebody else take it.
 *
 * Watching matters more than it sounds. A whole session of balance figures has
 * accumulated describing assaults nobody has ever seen — "the careful plan
 * leaves 9.4 of 12 standing" is a number until you sit and watch the plan go
 * wrong, at which point it is a design note. Spectating runs exactly the script
 * the harness scores, so the two can never drift into describing different
 * games.
 *
 * It is also the door to the editor, and to the levels that come back out of
 * it. The editor was reachable only by knowing a URL, which meant that in
 * practice the game shipped with a level editor nobody would ever find and that
 * a level you made could not be played without knowing a second URL. Those are
 * the same bug.
 */

export interface Pick {
  level: LevelDef;
  /** The scripted assault to watch, or null to command it yourself. */
  plan: string | null;
  seed: number;
}

export class Menu {
  private readonly root: HTMLElement;

  constructor(private readonly onStart: (pick: Pick) => void) {
    this.root = document.createElement('div');
    this.root.id = 'menu';
    document.body.append(this.root);
    this.render();
  }

  show(): void {
    this.render();
    this.root.classList.add('show');
  }

  hide(): void {
    this.root.classList.remove('show');
  }

  /** Something went wrong starting a contract; say so here rather than nowhere. */
  complain(message: string): void {
    this.show();
    const strap = this.root.querySelector('.strap');
    strap?.insertAdjacentHTML('afterend', `<p class="alarm">${escape(message)}</p>`);
  }

  private render(): void {
    this.root.innerHTML = `
      <div class="sheet">
        <h1>Cold Harbour</h1>
        <p class="strap">Pick a contract. Take it yourself, or watch a scripted
          assault — the same script the balance harness scores.</p>
        <div class="contracts"></div>
        <div class="mine"></div>
        <div class="workshop">
          <button class="edit" data-act="new-level">Level editor &rsaquo;</button>
          <span class="note">Build your own ground. Levels you add to the contract
            list show up above.</span>
        </div>
        <p class="foot">Esc reopens this. Each run takes a fresh seed, so the
          same plan twice is two different fights — the harness pins its own
          seeds when it wants the same one.</p>
      </div>
    `;

    const list = this.root.querySelector('.contracts')!;
    for (const level of LEVELS) list.append(this.card(level, Object.keys(MAPS[level.id]?.plans ?? {})));

    this.renderMine();

    (this.root.querySelector('[data-act="new-level"]') as HTMLButtonElement).onclick = () => {
      location.href = './editor.html';
    };
  }

  /** The shelf: levels made here, which nothing but this machine knows about. */
  private renderMine(): void {
    const mine = this.root.querySelector('.mine')!;
    const saved = savedLevels();
    mine.innerHTML = '';
    if (saved.length === 0) return;

    mine.insertAdjacentHTML('beforeend', '<h2>Your levels</h2>');
    for (const entry of saved) {
      const card = this.card(defineLevel(entry.data), []);

      const edit = document.createElement('button');
      edit.textContent = 'Edit';
      edit.title = 'Open this level in the editor';
      edit.onclick = () => { location.href = `./editor.html?level=${encodeURIComponent(entry.id)}`; };

      const remove = document.createElement('button');
      remove.className = 'quiet';
      remove.textContent = 'Remove';
      remove.title = 'Take it off the contract list. The level file, if you saved one, is untouched.';
      remove.onclick = () => {
        if (!confirm(`Take "${entry.name}" off the contract list?`)) return;
        forgetLevel(entry.id);
        this.renderMine();
      };

      card.querySelector('.actions')!.append(edit, remove);
      mine.append(card);
    }
  }

  private card(level: LevelDef, plans: string[]): HTMLElement {
    const card = document.createElement('div');
    card.className = 'contract';
    card.innerHTML = `
      <header>
        <span class="name">${escape(level.name)}</span>
        <span class="size">${level.size.width}&times;${level.size.height}m</span>
      </header>
      <p class="brief">${escape(level.brief)}</p>
    `;

    const actions = document.createElement('div');
    actions.className = 'actions';

    const command = document.createElement('button');
    command.className = 'go';
    command.textContent = 'Take the contract';
    command.onclick = () => this.start(level, null);
    actions.append(command);

    if (plans.length > 0) {
      const label = document.createElement('span');
      label.className = 'watch';
      label.textContent = 'watch:';
      actions.append(label);
      for (const plan of plans) {
        const button = document.createElement('button');
        button.textContent = plan;
        button.title = `Watch the scripted "${plan}" assault play out`;
        button.onclick = () => this.start(level, plan);
        actions.append(button);
      }
    }

    card.append(actions);
    return card;
  }

  private start(level: LevelDef, plan: string | null): void {
    this.hide();
    // A fresh seed each time, so "watch it again" is a different fight rather
    // than the same one replayed. Determinism is still there when it is wanted:
    // the harness pins its own seeds.
    this.onStart({ level, plan, seed: Math.floor(Math.random() * 1e6) });
  }
}

function escape(text: string): string {
  return text.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c] ?? c));
}
