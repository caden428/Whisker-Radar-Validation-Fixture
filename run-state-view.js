'use strict';

(function exposeRunStateView(global) {
  const STEP_ORDER = Object.freeze(['home', 'move', 'settle', 'trigger', 'hold', 'next', 'return']);
  const template = `<div class="state-flow">
    <div class="state-step" id="step-home"><span class="step-icon">H</span><span>Home</span></div>
    <div class="state-step" id="step-move"><span class="step-icon">M</span><span>Move</span></div>
    <div class="state-step" id="step-settle"><span class="step-icon">S</span><span>Settle</span></div>
    <div class="state-step" id="step-trigger"><span class="step-icon">T</span><span>Trigger</span></div>
    <div class="state-step" id="step-hold"><span class="step-icon">H</span><span>Hold</span></div>
    <div class="state-step" id="step-next"><span class="step-icon">N</span><span>Next</span></div>
    <div class="state-step" id="step-return"><span class="step-icon">R</span><span>Return</span></div>
  </div>`;
  class RunStateFlowElement extends HTMLElement {
    connectedCallback() { if (!this.firstElementChild) this.innerHTML = template; }
  }
  if (!customElements.get('run-state-flow')) customElements.define('run-state-flow', RunStateFlowElement);
  function render(active) {
    const activeIndex = STEP_ORDER.indexOf(active);
    STEP_ORDER.forEach((id, index) => {
      const element = document.getElementById(`step-${id}`);
      if (!element) return;
      element.className = 'state-step';
      if (active === null) return;
      if (index < activeIndex) element.classList.add('done');
      if (index === activeIndex) element.classList.add('active');
    });
  }
  global.RunStateView = Object.freeze({ STEP_ORDER, template, render, reset: () => render(null) });
})(window);
