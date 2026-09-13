import { MissionState, type Sim } from '../sim/sim.ts';
import type { LevelDef } from '../sim/levels.ts';
import { Faction, Posture, UnitState, type Unit } from '../sim/units.ts';
import type { Squad } from '../sim/squads.ts';

const SQUAD_CSS = ['var(--alpha)', 'var(--bravo)', 'var(--charlie)'];
const ROLE_SHORT: Record<string, string> = {
  'Team Leader': 'TL',
  'Automatic Rifleman': 'AR',
  Rifleman: 'RFL',
  Marksman: 'DMR',
  Breacher: 'BRC',
};

interface Alert {
  text: string;
  tone: 'info' | 'danger' | 'good';
  expires: number;
}

export class Hud {
  private readonly alerts: Alert[] = [];
  private readonly teamElements: HTMLElement[] = [];
  private readonly alertsRoot: HTMLElement;
  private readonly statusRoot: HTMLElement;
  private readonly endRoot: HTMLElement;
  private elapsed = 0;

  constructor(
    root: HTMLElement,
    level: LevelDef,
    sim: Sim,
    onSelectSquad: (squadId: number) => void,
    onRestart: () => void,
  ) {
    root.innerHTML = `
      <div id="top">
        <div id="mission" class="panel">
          <h1>${level.name}</h1>
          <p>${level.brief}</p>
        </div>
        <div id="status" class="panel"></div>
      </div>
      <div id="alerts"></div>
      <div id="bottom">
        <div id="teams"></div>
        <div id="help" class="panel">
          <div><b>Right-click</b> move tactically &middot; <b>double right-click</b> run</div>
          <div><b>Right-click + drag</b> set the arc they face on arrival</div>
          <div><b>Left-click / drag</b> select &middot; <b>1&ndash;3 / Tab</b> pick a team</div>
          <div><b>G</b> frag at the cursor &middot; <b>T</b> smoke &middot; <b>F</b> cover overlay</div>
          <div><b>Q / E</b> rotate &middot; <b>WASD</b> pan &middot; <b>Space</b> centre on team</div>
        </div>
      </div>
      <div id="end"><div>
        <h2></h2><p></p><button type="button">Run it again</button>
      </div></div>
    `;

    this.alertsRoot = root.querySelector('#alerts')!;
    this.statusRoot = root.querySelector('#status')!;
    this.endRoot = root.querySelector('#end')!;
    this.endRoot.querySelector('button')!.addEventListener('click', onRestart);

    const teams = root.querySelector('#teams')!;
    for (const squad of sim.playerSquads) {
      const element = document.createElement('div');
      element.className = 'team panel';
      element.style.setProperty('--edge', SQUAD_CSS[squad.id % SQUAD_CSS.length]);
      element.addEventListener('click', () => onSelectSquad(squad.id));
      teams.appendChild(element);
      this.teamElements.push(element);
    }
  }

  alert(text: string, tone: Alert['tone'] = 'info'): void {
    this.alerts.push({ text, tone, expires: this.elapsed + 4.5 });
    if (this.alerts.length > 4) this.alerts.shift();
    this.renderAlerts();
  }

  update(sim: Sim, selected: Set<number>, dt: number): void {
    this.elapsed += dt;

    const before = this.alerts.length;
    for (let i = this.alerts.length - 1; i >= 0; i--) {
      if (this.alerts[i].expires < this.elapsed) this.alerts.splice(i, 1);
    }
    if (this.alerts.length !== before) this.renderAlerts();

    this.renderStatus(sim);
    sim.playerSquads.forEach((squad, i) => {
      this.renderTeam(this.teamElements[i], sim, squad, selected.has(squad.id));
    });
    this.renderEnd(sim);
  }

  private renderStatus(sim: Sim): void {
    const players = sim.unitList.filter((u) => u.faction === Faction.Player);
    const standing = players.filter((u) => u.state === UnitState.Active).length;
    const down = players.filter((u) => u.state === UnitState.Down).length;
    const kia = players.filter((u) => u.state === UnitState.Dead).length;
    const hostiles = sim.unitList.filter(
      (u) => u.faction === Faction.Hostile && u.state === UnitState.Active,
    ).length;
    const minutes = Math.floor(sim.time / 60);
    const seconds = Math.floor(sim.time % 60);

    this.statusRoot.innerHTML = `
      <div class="row"><span class="label">Operators</span><span>${standing}/${players.length}</span></div>
      <div class="row"><span class="label">Down / KIA</span><span>${down} / ${kia}</span></div>
      <div class="row"><span class="label">Hostiles</span><span>${hostiles}</span></div>
      <div class="row"><span class="label">Elapsed</span><span>${minutes}:${String(seconds).padStart(2, '0')}</span></div>
    `;
  }

  private renderTeam(element: HTMLElement, sim: Sim, squad: Squad, selected: boolean): void {
    const members = sim.membersOf(squad);
    const active = members.filter((u) => u.state === UnitState.Active);
    element.classList.toggle('selected', selected);
    element.classList.toggle('wiped', active.length === 0);

    const pinned = active.some((u) => u.posture === Posture.Pinned);
    const contact = active.some((u) => u.visible.length > 0);
    const moving = active.some((u) => u.path.length > 0);
    let state = 'holding';
    let stateClass = '';
    if (pinned) {
      state = 'pinned';
      stateClass = 'pinned';
    } else if (contact) {
      state = 'in contact';
      stateClass = 'contact';
    } else if (moving) {
      state = 'moving';
    } else if (active.length === 0) {
      state = 'combat ineffective';
    }

    // What the team can still do about a position it cannot shoot, and about
    // ground it cannot cross. Both are decisions, so both belong on the card.
    const frags = active.reduce((n, u) => n + u.frags, 0);
    const smokes = active.reduce((n, u) => n + u.smokes, 0);

    element.innerHTML = `
      <header>
        <span class="name">${squad.name}</span>
        <span class="state ${stateClass}">${state}</span>
      </header>
      ${members.map((u) => this.renderOperator(u)).join('')}
      <div class="stores">
        <span class="${frags === 0 ? 'empty' : ''}">FRAG &times;${frags}</span>
        <span class="${smokes === 0 ? 'empty' : ''}">SMOKE &times;${smokes}</span>
      </div>
    `;
  }

  private renderOperator(u: Unit): string {
    const gone = u.state !== UnitState.Active;
    let tag = '';
    let tagClass = '';
    if (u.state === UnitState.Dead) {
      tag = 'KIA';
      tagClass = 'down';
    } else if (u.state === UnitState.Down) {
      tag = u.stabilized ? 'STABLE' : 'BLEEDING';
      tagClass = 'down';
    } else if (u.posture === Posture.Pinned) {
      tag = 'PINNED';
      tagClass = 'pinned';
    } else if (u.reloadTimer > 0) {
      tag = 'RELOAD';
    } else if (u.targetId !== null) {
      tag = 'ENGAGING';
    }

    return `
      <div class="op ${gone ? 'gone' : ''}">
        <span class="who"><span>${u.name}</span><span class="role">${ROLE_SHORT[u.role] ?? ''}</span></span>
        <span class="tag ${tagClass}">${tag}</span>
        <span class="bars">
          <span class="bar hp"><i style="width:${(u.hp / u.maxHp) * 100}%"></i></span>
          <span class="bar sup"><i style="width:${u.suppression * 100}%"></i></span>
        </span>
      </div>
    `;
  }

  private renderAlerts(): void {
    this.alertsRoot.innerHTML = this.alerts
      .map((a) => `<div class="alert ${a.tone === 'info' ? '' : a.tone}">${a.text}</div>`)
      .join('');
  }

  private renderEnd(sim: Sim): void {
    if (sim.missionState === MissionState.InProgress) {
      this.endRoot.classList.remove('show');
      return;
    }
    if (this.endRoot.classList.contains('show')) return;

    const won = sim.missionState === MissionState.Won;
    const players = sim.unitList.filter((u) => u.faction === Faction.Player);
    const kia = players.filter((u) => u.state === UnitState.Dead);
    const down = players.filter((u) => u.state === UnitState.Down);

    this.endRoot.classList.add('show', won ? 'won' : 'lost');
    this.endRoot.querySelector('h2')!.textContent = won ? 'Compound secured' : 'Team destroyed';
    this.endRoot.querySelector('p')!.textContent = won
      ? `${players.length - kia.length - down.length} walked out. ` +
        (kia.length ? `${kia.map((u) => u.name).join(', ')} did not.` : 'Nobody left behind.')
      : 'The contract is a write-off.';
  }
}
