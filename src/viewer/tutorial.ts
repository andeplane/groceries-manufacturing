/** A guided tour of the simulation: a card with steps, each flying the camera and highlighting part of the UI. */

export interface TourStep {
  title: string;
  /** HTML body. */
  body: string;
  /** Camera view to fly to when the step opens. */
  view?: string;
  /** CSS selector of a UI element to highlight. */
  highlight?: string;
}

const SEEN_KEY = 'kurvi-tour-seen-v1';

export function tourSeen(): boolean {
  try {
    return localStorage.getItem(SEEN_KEY) === '1';
  } catch {
    return false;
  }
}

function markSeen(): void {
  try {
    localStorage.setItem(SEEN_KEY, '1');
  } catch {
    // Private mode or blocked storage: the tour just shows again next time.
  }
}

export class Tour {
  private el: HTMLElement;
  private i = 0;
  private lit: Element | null = null;
  private onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') this.close();
    else if (e.key === 'Enter') this.go(this.i + 1);
  };

  constructor(
    private steps: TourStep[],
    private fly: (view: string) => void,
  ) {
    this.el = document.createElement('div');
    this.el.id = 'tour';
    this.el.setAttribute('role', 'dialog');
    this.el.setAttribute('aria-live', 'polite');
    document.body.appendChild(this.el);
  }

  open(): void {
    this.el.style.display = 'block';
    window.addEventListener('keydown', this.onKey);
    this.go(0);
  }

  close(): void {
    this.el.style.display = 'none';
    this.highlight(null);
    window.removeEventListener('keydown', this.onKey);
    markSeen();
  }

  private go(i: number): void {
    if (i >= this.steps.length) return this.close();
    this.i = Math.max(0, i);
    const s = this.steps[this.i];
    const last = this.i === this.steps.length - 1;
    const dots = this.steps.map((_, k) => `<i class="${k === this.i ? 'on' : ''}"></i>`).join('');
    this.el.innerHTML = `
      <div class="tour-top"><span class="tour-count">${this.i + 1} / ${this.steps.length}</span><button class="tour-skip" type="button">Skip tour</button></div>
      <h2>${s.title}</h2>
      <div class="tour-body">${s.body}</div>
      <div class="tour-nav">
        <div class="tour-dots">${dots}</div>
        <button class="tour-back" type="button" ${this.i === 0 ? 'disabled' : ''}>Back</button>
        <button class="tour-next" type="button">${last ? 'Start exploring' : 'Next'}</button>
      </div>`;
    (this.el.querySelector('.tour-skip') as HTMLElement).onclick = () => this.close();
    (this.el.querySelector('.tour-back') as HTMLElement).onclick = () => this.go(this.i - 1);
    (this.el.querySelector('.tour-next') as HTMLElement).onclick = () => this.go(this.i + 1);
    if (s.view) this.fly(s.view);
    this.highlight(s.highlight ? document.querySelector(s.highlight) : null);
  }

  private highlight(el: Element | null): void {
    this.lit?.classList.remove('tour-hl');
    this.lit = el;
    el?.classList.add('tour-hl');
  }
}

export const TOUR_STEPS: TourStep[] = [
  {
    title: 'Welcome to the Kurvi packing loop',
    view: 'overview',
    body: `<p>This is a simulation of the packing and outbound logistics in an online grocery warehouse. Kurvi is a made-up grocer, but the products, order sizes and timings are realistic.</p>
      <p>Every grocery order has to be picked into boxes, kept at the right temperature and loaded onto the right truck. Most of a warehouse's labour goes into that, so small changes in layout or strategy can change how many items each person handles per hour by a lot.</p>
      <p>The simulation lets us try those changes before anyone moves a single conveyor. It runs live in front of you, and the same engine can run hours of operation in a fraction of a second.</p>`,
  },
  {
    title: 'Orders become boxes',
    view: 'induct',
    body: `<p>Customers place orders of roughly 1,000 to 1,500 kr, picked from a catalogue of over 5,000 real grocery products. Baskets are realistic: someone buying tortillas is likely to buy salsa and cheese too.</p>
      <p>A planner splits each order into boxes. Ambient, chilled and frozen goods never share a box, and each box has a volume and weight limit. The box erector here folds empty boxes and feeds them onto the loop.</p>`,
  },
  {
    title: 'The loop',
    view: 'loop',
    body: `<p>Boxes ride a long circular conveyor past all the packing stations. Each box knows which stations hold the products it still needs.</p>
      <p>When a box passes a station it needs, it tries to get off. If that station is full, the box simply goes around again, which costs time. Once a box has everything, it leaves the loop for the dock.</p>`,
  },
  {
    title: 'Packing stations',
    view: 'station',
    body: `<p>Each station is a short belt running alongside the loop. Boxes queue there (four by default), the packer fills the front box from the shelf behind them, and the finished box rejoins the loop further on.</p>
      <p>Picking time per item varies like a real person's: about 4.5 seconds on average, never faster than 2. The light on the pole shows the station's state: <b style="color:#22c55e">green</b> packing, <b style="color:#facc15">yellow</b> waiting for boxes, <b style="color:#ef4444">red</b> blocked because the finished box can't get back onto the loop.</p>`,
  },
  {
    title: 'Which products go where',
    view: 'overview',
    highlight: '#bars',
    body: `<p>Deciding which products live at which station is called slotting. Put all the taco ingredients on one station and a taco Friday swamps it while the rest wait. Spread them out and the load evens out.</p>
      <p>These bars show how busy each station has been over the last 10 minutes, coloured by temperature zone. Red on top means time spent blocked. Click a bar or a station to see what it stocks.</p>`,
  },
  {
    title: 'Dock and trucks',
    view: 'dock',
    body: `<p>Finished boxes travel to the dock and are stacked by delivery route. A truck can't leave until its last box arrives, so one slow box can hold up 99 others.</p>
      <p>The signs above each door show the route and how many boxes are ready. Dock wait, the time from a route's first box to its last, is one of the numbers worth keeping low.</p>`,
  },
  {
    title: 'The numbers',
    highlight: '#hud',
    body: `<p>The big number is <b>UPH per packer</b>: items packed per packer per hour. Around 450 to 500 is good.</p>
      <p><b>Warehouse UPH</b> also counts support staff (receiving, restocking, loading), which is how the industry usually reports it, at around 300. The graph tracks both over the shift, with that industry level as a dashed line.</p>`,
  },
  {
    title: 'Now try it yourself',
    highlight: '.lil-gui.root',
    body: `<p>Use the panel to change things while it runs. Set <i>theme surge</i> to taco and watch stations light up red, then switch <i>product slotting</i> to spread. Layout settings like cache size and number of stations take effect when you restart.</p>
      <p>Drag to orbit, scroll to zoom towards the mouse, WASD to fly, arrow keys to turn, and M to walk around at eye level. You can replay this tour from Camera → Tutorial.</p>`,
  },
];
