import { LEVELS } from '../sim/levels.ts';
import { MAPS } from '../sim/plans.ts';
import type { LevelDef } from '../sim/world/level-data.ts';

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

  private render(): void {
    this.root.innerHTML = `
      <div class="sheet">
        <h1>Cold Harbour</h1>
        <p class="strap">Pick a contract. Take it yourself, or watch a scripted
          assault — the same script the balance harness scores.</p>
        <div class="contracts"></div>
        <p class="foot">Esc reopens this. Each run takes a fresh seed, so the
          same plan twice is two different fights — the harness pins its own
          seeds when it wants the same one.</p>
      </div>
    `;
    const list = this.root.querySelector('.contracts')!;

    for (const level of LEVELS) {
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

      const plans = Object.keys(MAPS[level.id]?.plans ?? {});
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
      list.append(card);
    }
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
