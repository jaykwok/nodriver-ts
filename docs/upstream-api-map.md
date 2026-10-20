# Upstream API map

[简体中文](zh-CN/upstream-api-map.md)

Compared against `core/browser.py`, `tab.py`, `element.py`, `connection.py` and `config.py` at nodriver commit `219a60d65d82fb3d137d0c2c5b1fb285a9f837d0`, this lists all 163 public members (overloads with the same name are merged). Python magic methods, private implementation details and the generated CDP modules are replaced by Promises, standard collections and the official protocol types. Proxies are handled by proxy-chain; screen, media and interactive debugging helpers are out of scope.

Where the counterpart is a high-level API, its behaviour is covered by integration tests. Where it is a `cdp` command or `evaluate`, you implement it yourself through the protocol or a page script; there is no wrapper of the same name. Behavioural limits are described in [API](api.md) and [Support](support.md).

| Upstream member                              | TypeScript counterpart                                                                        |
| -------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `browser.Browser.create`                     | Browser.launch / Browser.connect                                                              |
| `browser.Browser.main_tab`                   | Browser.tabs[0]                                                                               |
| `browser.Browser.targets`                    | Browser.targetInfo                                                                            |
| `browser.Browser.tabs`                       | Browser.tabs                                                                                  |
| `browser.Browser.cookies`                    | Browser.defaultContext.cookies                                                                |
| `browser.Browser.stopped`                    | Browser.closed                                                                                |
| `browser.Browser.wait`                       | Explicit condition wait / `setTimeout` (node:timers/promises)                                 |
| `browser.Browser.get`                        | Browser.newTab / Tab.goto                                                                     |
| `browser.Browser.create_context`             | Browser.newContext                                                                            |
| `browser.Browser.start`                      | Browser.launch                                                                                |
| `browser.Browser.grant_all_permissions`      | BrowserContext.grantPermissions (explicit permission list)                                    |
| `browser.Browser.tile_windows`               | Automatic screen detection intentionally omitted; Tab.windowBounds can build layouts          |
| `browser.Browser.update_targets`             | Automatic target discovery; Browser.targetInfo                                                |
| `browser.Browser.stop`                       | Browser.close                                                                                 |
| `browser.CookieJar.get_all`                  | BrowserContext.cookies                                                                        |
| `browser.CookieJar.set_all`                  | BrowserContext.setCookies                                                                     |
| `browser.CookieJar.save`                     | BrowserContext.saveCookies (JSON)                                                             |
| `browser.CookieJar.load`                     | BrowserContext.loadCookies (JSON)                                                             |
| `browser.CookieJar.clear`                    | BrowserContext.clearCookies                                                                   |
| `browser.HTTPApi.from_target`                | Protocol extension or standard TypeScript data structures; no wrapper of the same name        |
| `browser.HTTPApi.get`                        | Browser.newTab / Tab.goto                                                                     |
| `browser.HTTPApi.post`                       | Protocol extension or standard TypeScript data structures; no wrapper of the same name        |
| `connection.Connection.attached`             | Session.closed / id                                                                           |
| `connection.Connection.transactions`         | Connection.pendingCount (sensitive payloads not exposed)                                      |
| `connection.Connection.last_transaction`     | Request history cache intentionally omitted                                                   |
| `connection.Connection.add_handler`          | Session.on (returns an unsubscribe function)                                                  |
| `connection.Connection.remove_handler`       | Call the function returned by Session.on                                                      |
| `connection.Connection.aopen`                | Browser.connect                                                                               |
| `connection.Connection.aclose`               | Browser.disconnect                                                                            |
| `connection.Connection.attach`               | Automatic attach; or cdp Target.attachToTarget                                                |
| `connection.Connection.detach`               | cdp Target.detachFromTarget                                                                   |
| `connection.Connection.send`                 | Session.send / sendWith                                                                       |
| `connection.Connection.process_event`        | Routed automatically by Connection; no API for injecting events                               |
| `config.Config.browser_args`                 | LaunchOptions.args                                                                            |
| `config.Config.user_data_dir`                | LaunchOptions.userDataDir                                                                     |
| `config.Config.uses_custom_data_dir`         | Browser.process.temporary                                                                     |
| `config.Config.add_extension`                | Explicit Chrome args; no wrapper for unpacking/installing extensions                          |
| `config.Config.add_argument`                 | LaunchOptions.args                                                                            |
| `tab.Tab.browser`                            | Protocol extension or standard TypeScript data structures; no wrapper of the same name        |
| `tab.Tab.get_frames`                         | Tab.frames                                                                                    |
| `tab.Tab.inspector_url`                      | Browser.endpoint + target ID (no wrapper for opening the UI)                                  |
| `tab.Tab.inspector_open`                     | Intentionally omitted: side effect of launching an external app                               |
| `tab.Tab.open_external_inspector`            | Intentionally omitted: side effect of launching an external app                               |
| `tab.Tab.feed_cdp`                           | Session.send / on                                                                             |
| `tab.Tab.get`                                | Browser.newTab / Tab.goto                                                                     |
| `tab.Tab.find`                               | waitForSelector({text})                                                                       |
| `tab.Tab.select`                             | waitForSelector(css)                                                                          |
| `tab.Tab.find_all`                           | queryAll({text})                                                                              |
| `tab.Tab.select_all`                         | queryAll(css)                                                                                 |
| `tab.Tab.sleep`                              | `setTimeout` (node:timers/promises)                                                           |
| `tab.Tab.xpath`                              | queryAll({xpath})                                                                             |
| `tab.Tab.query_selector_all`                 | queryAll(css)                                                                                 |
| `tab.Tab.query_selector`                     | query(css)                                                                                    |
| `tab.Tab.find_elements_by_text`              | queryAll({text})                                                                              |
| `tab.Tab.find_element_by_text`               | query({text})                                                                                 |
| `tab.Tab.back`                               | Tab.go(-1)                                                                                    |
| `tab.Tab.forward`                            | Tab.go(1)                                                                                     |
| `tab.Tab.reload`                             | Tab.reload                                                                                    |
| `tab.Tab.evaluate`                           | Tab.evaluate / Frame.evaluate                                                                 |
| `tab.Tab.js_dumps`                           | evaluate + JSHandle.jsonValue (CDP serialization limits)                                      |
| `tab.Tab.close`                              | close                                                                                         |
| `tab.Tab.get_window`                         | Tab.windowBounds                                                                              |
| `tab.Tab.get_content`                        | Tab.content                                                                                   |
| `tab.Tab.maximize`                           | Tab.windowBounds({windowState:"maximized"})                                                   |
| `tab.Tab.minimize`                           | Tab.windowBounds({windowState:"minimized"})                                                   |
| `tab.Tab.fullscreen`                         | Tab.windowBounds({windowState:"fullscreen"})                                                  |
| `tab.Tab.medimize`                           | Tab.windowBounds({windowState:"normal"})                                                      |
| `tab.Tab.set_window_size`                    | Tab.windowBounds({left,top,width,height})                                                     |
| `tab.Tab.activate`                           | Tab.bringToFront                                                                              |
| `tab.Tab.bring_to_front`                     | Tab.bringToFront                                                                              |
| `tab.Tab.set_window_state`                   | Tab.windowBounds                                                                              |
| `tab.Tab.scroll_down`                        | Tab.mouse.wheel                                                                               |
| `tab.Tab.scroll_up`                          | Tab.mouse.wheel                                                                               |
| `tab.Tab.wait`                               | Explicit condition wait / `setTimeout` (node:timers/promises)                                 |
| `tab.Tab.wait_for`                           | waitForSelector / waitForFunction / waitForNavigation                                         |
| `tab.Tab.download_file`                      | Browser download flow with waitForDownload; or an explicit fetch (different cookie semantics) |
| `tab.Tab.save_screenshot`                    | screenshot                                                                                    |
| `tab.Tab.set_download_path`                  | BrowserContext.setDownloadDirectory                                                           |
| `tab.Tab.get_all_linked_sources`             | queryAll("[src],[href]") + attribute/evaluate                                                 |
| `tab.Tab.get_all_urls`                       | URL parsing inside evaluate                                                                   |
| `tab.Tab.get_local_storage`                  | Frame.storage                                                                                 |
| `tab.Tab.set_local_storage`                  | Frame.setStorage                                                                              |
| `tab.Tab.get_frame_tree`                     | Tab.frames / cdp Page.getFrameTree                                                            |
| `tab.Tab.get_frame_resource_tree`            | Tab.resources                                                                                 |
| `tab.Tab.get_frame_resource_urls`            | resources in the Tab.resources tree                                                           |
| `tab.Tab.search_frame_resources`             | cdp Page.searchInResource                                                                     |
| `tab.Tab.verify_cf`                          | Intentionally excluded: no promise of automatic challenge bypass                              |
| `tab.Tab.template_location`                  | Intentionally excluded: OpenCV image-matching dependency                                      |
| `tab.Tab.bypass_insecure_connection_warning` | Warning bypass intentionally not provided; configure the Security domain explicitly yourself  |
| `tab.Tab.mouse_move`                         | Mouse.move                                                                                    |
| `tab.Tab.scroll_bottom_reached`              | Compare scrollY/scrollHeight inside evaluate                                                  |
| `tab.Tab.mouse_click`                        | Element.click / Mouse.click                                                                   |
| `tab.Tab.mouse_drag`                         | Mouse.drag (pointer drag)                                                                     |
| `tab.Tab.flash_point`                        | Intentionally omitted: visible debug markers on the page                                      |
| `element.Element.tag`                        | Official DOM.Node fields from Element.describe(); no mirror of the Python attributes          |
| `element.Element.tag_name`                   | Official DOM.Node fields from Element.describe(); no mirror of the Python attributes          |
| `element.Element.node_id`                    | Official DOM.Node fields from Element.describe(); no mirror of the Python attributes          |
| `element.Element.backend_node_id`            | Official DOM.Node fields from Element.describe(); no mirror of the Python attributes          |
| `element.Element.node_type`                  | Official DOM.Node fields from Element.describe(); no mirror of the Python attributes          |
| `element.Element.node_name`                  | Official DOM.Node fields from Element.describe(); no mirror of the Python attributes          |
| `element.Element.local_name`                 | Official DOM.Node fields from Element.describe(); no mirror of the Python attributes          |
| `element.Element.node_value`                 | Official DOM.Node fields from Element.describe(); no mirror of the Python attributes          |
| `element.Element.parent_id`                  | Official DOM.Node fields from Element.describe(); no mirror of the Python attributes          |
| `element.Element.child_node_count`           | Official DOM.Node fields from Element.describe(); no mirror of the Python attributes          |
| `element.Element.attributes`                 | Element.describe().attributes                                                                 |
| `element.Element.document_url`               | Official DOM.Node fields from Element.describe(); no mirror of the Python attributes          |
| `element.Element.base_url`                   | Official DOM.Node fields from Element.describe(); no mirror of the Python attributes          |
| `element.Element.public_id`                  | Official DOM.Node fields from Element.describe(); no mirror of the Python attributes          |
| `element.Element.system_id`                  | Official DOM.Node fields from Element.describe(); no mirror of the Python attributes          |
| `element.Element.internal_subset`            | Official DOM.Node fields from Element.describe(); no mirror of the Python attributes          |
| `element.Element.xml_version`                | Official DOM.Node fields from Element.describe(); no mirror of the Python attributes          |
| `element.Element.value`                      | Element.evaluate                                                                              |
| `element.Element.pseudo_type`                | Official DOM.Node fields from Element.describe(); no mirror of the Python attributes          |
| `element.Element.pseudo_identifier`          | Official DOM.Node fields from Element.describe(); no mirror of the Python attributes          |
| `element.Element.shadow_root_type`           | Official DOM.Node fields from Element.describe(); no mirror of the Python attributes          |
| `element.Element.frame_id`                   | Official DOM.Node fields from Element.describe(); no mirror of the Python attributes          |
| `element.Element.content_document`           | Official DOM.Node fields from Element.describe(); no mirror of the Python attributes          |
| `element.Element.shadow_roots`               | Official DOM.Node fields from Element.describe(); no mirror of the Python attributes          |
| `element.Element.template_content`           | Official DOM.Node fields from Element.describe(); no mirror of the Python attributes          |
| `element.Element.pseudo_elements`            | Official DOM.Node fields from Element.describe(); no mirror of the Python attributes          |
| `element.Element.imported_document`          | Official DOM.Node fields from Element.describe(); no mirror of the Python attributes          |
| `element.Element.distributed_nodes`          | Official DOM.Node fields from Element.describe(); no mirror of the Python attributes          |
| `element.Element.is_svg`                     | Official DOM.Node fields from Element.describe(); no mirror of the Python attributes          |
| `element.Element.compatibility_mode`         | Official DOM.Node fields from Element.describe(); no mirror of the Python attributes          |
| `element.Element.assigned_slot`              | Official DOM.Node fields from Element.describe(); no mirror of the Python attributes          |
| `element.Element.tab`                        | Element.frame.tab                                                                             |
| `element.Element.shadow_children`            | Element.queryAll (pierces by default)                                                         |
| `element.Element.save_to_dom`                | Element.evaluate (explicit DOM change)                                                        |
| `element.Element.remove_from_dom`            | Element.evaluate(el=>el.remove())                                                             |
| `element.Element.update`                     | Query again for a valid element; handles from an old document are not revived                 |
| `element.Element.node`                       | Element.describe                                                                              |
| `element.Element.tree`                       | Element.describe / DOM.getDocument                                                            |
| `element.Element.attrs`                      | Element.describe().attributes                                                                 |
| `element.Element.parent`                     | Element.evaluate / DOM.describeNode                                                           |
| `element.Element.children`                   | Element.queryAll(":scope > *")                                                                |
| `element.Element.remote_object`              | Frame.evaluateHandle                                                                          |
| `element.Element.object_id`                  | JSHandle.object.objectId (bound to the document generation)                                   |
| `element.Element.click`                      | Element.click                                                                                 |
| `element.Element.get_js_attributes`          | Element.evaluate                                                                              |
| `element.Element.apply`                      | Element.evaluate                                                                              |
| `element.Element.get_position`               | DOM.getBoxModel / Element.evaluate(getBoundingClientRect)                                     |
| `element.Element.mouse_click`                | Element.click / Mouse.click                                                                   |
| `element.Element.mouse_move`                 | Mouse.move                                                                                    |
| `element.Element.mouse_drag`                 | Mouse.drag (pointer drag)                                                                     |
| `element.Element.scroll_into_view`           | cdp DOM.scrollIntoViewIfNeeded                                                                |
| `element.Element.clear_input`                | Element.fill("")                                                                              |
| `element.Element.send_keys`                  | focus + Keyboard.insertText                                                                   |
| `element.Element.send_file`                  | Element.upload                                                                                |
| `element.Element.focus`                      | Element.focus                                                                                 |
| `element.Element.select_option`              | Element.select                                                                                |
| `element.Element.set_value`                  | Element.fill / evaluate                                                                       |
| `element.Element.set_text`                   | Element.evaluate (explicit DOM change)                                                        |
| `element.Element.get_html`                   | Element.html                                                                                  |
| `element.Element.text`                       | Element.text                                                                                  |
| `element.Element.text_all`                   | Element.text                                                                                  |
| `element.Element.query_selector_all`         | queryAll(css)                                                                                 |
| `element.Element.query_selector`             | query(css)                                                                                    |
| `element.Element.save_screenshot`            | screenshot                                                                                    |
| `element.Element.flash`                      | Intentionally omitted: visible debug effects                                                  |
| `element.Element.highlight_overlay`          | Optional: cdp Overlay domain                                                                  |
| `element.Element.record_video`               | No encoder by design; extend with CDP Page.startScreencast                                    |
| `element.Element.is_recording`               | No high-level recording session                                                               |
| `element.Position.to_viewport`               | Protocol extension or standard TypeScript data structures; no wrapper of the same name        |
