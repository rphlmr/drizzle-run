import { describe, expect, it } from "vitest";
import { createActor } from "xstate";

import { getPhoneView, getWorkView, workspaceViewMachine, type WorkspaceViewInput } from "./workspace-view-machine";

function makeView({ asideView = false, afterRun = "output" }: Partial<WorkspaceViewInput> = {}) {
  const actor = createActor(workspaceViewMachine, { input: { asideView, afterRun } }).start();

  return {
    actor,
    phoneView: () => getPhoneView(actor.getSnapshot()),
    workView: () => getWorkView(actor.getSnapshot()),
    context: () => actor.getSnapshot().context,
  };
}

describe("workspaceViewMachine", () => {
  it("should resolve the opening view before the actor starts, as a first render reads it", () => {
    const actor = createActor(workspaceViewMachine, { input: { asideView: true, afterRun: "aside" } });

    expect(getPhoneView(actor.getSnapshot())).toBe("aside");
  });

  it("should open on the side panel when it is a view of its own, on the code otherwise", () => {
    expect(makeView({ asideView: true }).phoneView()).toBe("aside");
    expect(makeView().phoneView()).toBe("code");
  });

  it("should ignore the side panel without a side panel view", () => {
    const view = makeView();

    view.actor.send({ type: "aside.show" });

    expect(view.phoneView()).toBe("code");
  });

  it("should return from the side panel to the code or output the reader left", () => {
    const view = makeView({ asideView: true });

    view.actor.send({ type: "output.show" });
    view.actor.send({ type: "aside.show" });

    expect(view.phoneView()).toBe("aside");
    expect(view.workView()).toBe("output");

    view.actor.send({ type: "work.show" });

    expect(view.phoneView()).toBe("output");
  });

  it("should leave the side panel for the code, as a highlight that asks to be seen does", () => {
    const view = makeView({ asideView: true });

    view.actor.send({ type: "code.show" });

    expect(view.phoneView()).toBe("code");
  });

  it("should pick a side with its view, and keep the view when only the side changes", () => {
    const view = makeView();

    view.actor.send({ type: "output.show", side: 1 });

    expect(view.context().side).toBe(1);
    expect(view.phoneView()).toBe("output");

    view.actor.send({ type: "side.show", side: 0 });

    expect(view.context().side).toBe(0);
    expect(view.phoneView()).toBe("output");

    view.actor.send({ type: "code.show" });

    expect(view.context().side).toBe(0);
  });

  it("should show the side panel's verdict after a phone's run and mark the output as new", () => {
    const view = makeView({ asideView: true, afterRun: "aside" });

    view.actor.send({ type: "code.show" });
    view.actor.send({ type: "run.settled", phone: true });

    expect(view.phoneView()).toBe("aside");
    expect(view.context().unseenOutput).toBe(true);

    view.actor.send({ type: "output.show" });

    expect(view.context().unseenOutput).toBe(false);
  });

  it("should show the output after a phone's run without a side panel view", () => {
    const view = makeView({ afterRun: "aside" });

    view.actor.send({ type: "run.settled", phone: true });

    expect(view.phoneView()).toBe("output");
    expect(view.context().unseenOutput).toBe(false);
  });

  it("should move the output forward behind an open side panel after a phone's run", () => {
    const view = makeView({ asideView: true, afterRun: "output" });

    view.actor.send({ type: "run.settled", phone: true });

    expect(view.phoneView()).toBe("aside");
    expect(view.workView()).toBe("output");
  });

  it("should only mark the output as new after a desktop's run", () => {
    const view = makeView({ asideView: true, afterRun: "aside" });

    view.actor.send({ type: "code.show" });
    view.actor.send({ type: "run.settled", phone: false });

    expect(view.phoneView()).toBe("code");
    expect(view.context().unseenOutput).toBe(true);
  });
});
