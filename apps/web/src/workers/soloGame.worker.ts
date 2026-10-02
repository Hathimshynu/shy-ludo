/// <reference lib="webworker" />
import { type HostInbound, LocalGameHost } from '../game/localHost';

declare const self: DedicatedWorkerGlobalScope;

const host = new LocalGameHost((msg) => self.postMessage(msg));
self.onmessage = (e: MessageEvent<HostInbound>) => host.handle(e.data);
