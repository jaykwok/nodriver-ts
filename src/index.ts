export { Browser } from './browser/browser.ts';
export type { ConnectOptions, AttachPolicy } from './browser/browser.ts';
export { BrowserContext } from './browser/context.ts';
export { TabScope, type TabScopeCloseResult } from './browser/tab-scope.ts';
export type {
  ClearSiteDataOptions,
  ClearSiteDataResult,
  ContextOptions,
  RestoreStorageOptions,
  SavedStorageState,
  SiteDataType,
  StorageState,
  StorageStateOptions,
} from './browser/context.ts';
export type { IndexedDBDatabase, IndexedDBIndex, IndexedDBStore } from './browser/indexeddb.ts';
export { encryptState, decryptState, type StateKey } from './browser/state-crypto.ts';
export { findExecutable, acquireProfileLock, AGENT_ARGS } from './browser/launcher.ts';
export type { LaunchOptions, ProfilePreparation } from './browser/launcher.ts';
export { updateProfileSettings } from './browser/profile.ts';
export type { ProfileSettings, ProfileSettingsUpdate } from './browser/profile.ts';
export { ReleaseUncertainError } from './browser/guardian.ts';
export { getStartupDiagnostics } from './browser/startup.ts';
export type {
  StartupStage,
  StartupDiagnostics,
  StartupProcessDiagnostics,
} from './browser/startup.ts';
export { XvfbSession } from './optional/xvfb.ts';
export type { XvfbOptions, XvfbStartOptions } from './optional/xvfb.ts';
export { resolveProxyEnvironment } from './optional/native-environment.ts';
export type { NativeEnvironment, ProxyEnvironmentOptions } from './optional/native-environment.ts';
export { Download } from './browser/download.ts';
export { Tab } from './page/tab.ts';
export type { Environment } from './page/tab.ts';
export type {
  DiagnoseEnvironmentOptions,
  EnvironmentDiagnostics,
  AlignEnvironmentOptions,
  EnvironmentVerification,
  GeoIPResolver,
  GeoIPResult,
  Observation,
} from './page/diagnostics.ts';
export type {
  EnvironmentReport,
  NavigatorSnapshot,
  DocumentEnvironment,
  InspectEnvironmentOptions,
} from './page/environment.ts';
export { Frame, JSHandle } from './page/frames.ts';
export type { EvaluateOptions, World, EvaluationInput } from './page/frames.ts';
export type { NavigationOptions } from './page/navigation.ts';
export { Network, Route } from './page/network.ts';
export type { Response } from './page/network.ts';
export {
  Element,
  type SetCheckedResult,
  type TypeOptions,
  type ElementEvaluateOptions,
} from './dom/element.ts';
export type { FetchOptions, FetchResponse } from './page/fetch.ts';
export { Locator } from './dom/locator.ts';
export type { Selector, QueryOptions } from './dom/query.ts';
export { Mouse, Keyboard, keyDefinition, parseChord } from './input/input.ts';
export type { ComposeOptions, KeyDefinition } from './input/input.ts';
export { InputActionError, InputBlockedError } from './input/behavior.ts';
export type {
  InputPolicy,
  InputReport,
  InputSent,
  InputOptions,
  InputCheckpoint,
  InputCleanupReport,
} from './input/behavior.ts';
export { Composition } from './input/composition.ts';
export type { CompositionSelection, CompositionOptions } from './input/composition.ts';
export { InputScope, createInputScope } from './input/scope.ts';
export type { InputScopeOptions, InputScopeRunOptions, ScopedInput } from './input/scope.ts';
export { PresentationLease, createPresentationLease } from './page/presentation.ts';
export type {
  PresentationLeaseLifecycle,
  PresentationLeaseReason,
  PresentationLeaseOptions,
  PresentationScreencastOptions,
  PresentationReport,
} from './page/presentation.ts';
export { Connection, Session, TargetSession, SessionEndedError } from './protocol/connection.ts';
export type {
  Command,
  Event,
  Params,
  Result,
  EventParams,
  CdpEvent,
  ConnectionOptions,
  TraceEntry,
  EndReason,
  ConnectionObserver,
  ResponseObservation,
  PerformanceObservation,
} from './protocol/connection.ts';
export type { Transport } from './transport/transport.ts';
export { WebSocketTransport } from './transport/websocket.ts';
export { PipeTransport, PipeDecoder } from './transport/pipe.ts';
export { ProxyForwarder } from './optional/proxy.ts';
export type { EventHub, Listener, WaitOptions } from './utils.ts';
export * from './errors.ts';
export type { Protocol } from 'devtools-protocol';
