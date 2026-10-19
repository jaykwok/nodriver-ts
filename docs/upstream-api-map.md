# 上游 API 对应表

对照 nodriver 提交 `219a60d65d82fb3d137d0c2c5b1fb285a9f837d0` 的 `core/browser.py`、`tab.py`、`element.py`、`connection.py`、`config.py`，列出全部 163 个 public 成员（同名重载合并）。Python 魔术方法、私有实现和生成的 CDP 模块由 Promise、标准集合和官方协议类型替代；代理由 proxy-chain 处理，屏幕、媒体和交互式调试辅助不在范围内。

对应项为高层 API 时，行为由集成测试覆盖；为 `cdp` 命令或 `evaluate` 时，表示通过协议或页面脚本自行实现，没有同名封装。行为边界见 [API](api.md) 与 [支持范围](support.md)。

| 上游成员                                     | TS 对应                                                           |
| -------------------------------------------- | ----------------------------------------------------------------- |
| `browser.Browser.create`                     | Browser.launch / Browser.connect                                  |
| `browser.Browser.main_tab`                   | Browser.tabs[0]                                                   |
| `browser.Browser.targets`                    | Browser.targetInfo                                                |
| `browser.Browser.tabs`                       | Browser.tabs                                                      |
| `browser.Browser.cookies`                    | Browser.defaultContext.cookies                                    |
| `browser.Browser.stopped`                    | Browser.closed                                                    |
| `browser.Browser.wait`                       | 显式条件等待 / `setTimeout`（node:timers/promises）               |
| `browser.Browser.get`                        | Browser.newTab / Tab.goto                                         |
| `browser.Browser.create_context`             | Browser.newContext                                                |
| `browser.Browser.start`                      | Browser.launch                                                    |
| `browser.Browser.grant_all_permissions`      | BrowserContext.grantPermissions（显式权限列表）                   |
| `browser.Browser.tile_windows`               | 有意省略自动屏幕探测；Tab.windowBounds 可构建布局                 |
| `browser.Browser.update_targets`             | 自动 Target discovery；Browser.targetInfo                         |
| `browser.Browser.stop`                       | Browser.close                                                     |
| `browser.CookieJar.get_all`                  | BrowserContext.cookies                                            |
| `browser.CookieJar.set_all`                  | BrowserContext.setCookies                                         |
| `browser.CookieJar.save`                     | BrowserContext.saveCookies（JSON）                                |
| `browser.CookieJar.load`                     | BrowserContext.loadCookies（JSON）                                |
| `browser.CookieJar.clear`                    | BrowserContext.clearCookies                                       |
| `browser.HTTPApi.from_target`                | 协议扩展或标准 TypeScript 数据结构；不提供同名封装                |
| `browser.HTTPApi.get`                        | Browser.newTab / Tab.goto                                         |
| `browser.HTTPApi.post`                       | 协议扩展或标准 TypeScript 数据结构；不提供同名封装                |
| `connection.Connection.attached`             | Session.closed / id                                               |
| `connection.Connection.transactions`         | Connection.pendingCount（不暴露敏感 payload）                     |
| `connection.Connection.last_transaction`     | 有意省略请求历史缓存                                              |
| `connection.Connection.add_handler`          | Session.on（返回取消订阅函数）                                    |
| `connection.Connection.remove_handler`       | 调用 Session.on 返回的函数                                        |
| `connection.Connection.aopen`                | Browser.connect                                                   |
| `connection.Connection.aclose`               | Browser.disconnect                                                |
| `connection.Connection.attach`               | 自动附加；或 cdp Target.attachToTarget                            |
| `connection.Connection.detach`               | cdp Target.detachFromTarget                                       |
| `connection.Connection.send`                 | Session.send / sendWith                                           |
| `connection.Connection.process_event`        | Connection 自动路由，不暴露可注入事件 API                         |
| `config.Config.browser_args`                 | LaunchOptions.args                                                |
| `config.Config.user_data_dir`                | LaunchOptions.userDataDir                                         |
| `config.Config.uses_custom_data_dir`         | Browser.process.temporary                                         |
| `config.Config.add_extension`                | 显式 Chrome args；不提供扩展解压/安装封装                         |
| `config.Config.add_argument`                 | LaunchOptions.args                                                |
| `tab.Tab.browser`                            | 协议扩展或标准 TypeScript 数据结构；不提供同名封装                |
| `tab.Tab.get_frames`                         | Tab.frames                                                        |
| `tab.Tab.inspector_url`                      | Browser.endpoint + target ID（不提供 UI 启动封装）                |
| `tab.Tab.inspector_open`                     | 有意省略外部应用启动副作用                                        |
| `tab.Tab.open_external_inspector`            | 有意省略外部应用启动副作用                                        |
| `tab.Tab.feed_cdp`                           | Session.send / on                                                 |
| `tab.Tab.get`                                | Browser.newTab / Tab.goto                                         |
| `tab.Tab.find`                               | waitForSelector({text})                                           |
| `tab.Tab.select`                             | waitForSelector(css)                                              |
| `tab.Tab.find_all`                           | queryAll({text})                                                  |
| `tab.Tab.select_all`                         | queryAll(css)                                                     |
| `tab.Tab.sleep`                              | `setTimeout`（node:timers/promises）                              |
| `tab.Tab.xpath`                              | queryAll({xpath})                                                 |
| `tab.Tab.query_selector_all`                 | queryAll(css)                                                     |
| `tab.Tab.query_selector`                     | query(css)                                                        |
| `tab.Tab.find_elements_by_text`              | queryAll({text})                                                  |
| `tab.Tab.find_element_by_text`               | query({text})                                                     |
| `tab.Tab.back`                               | Tab.go(-1)                                                        |
| `tab.Tab.forward`                            | Tab.go(1)                                                         |
| `tab.Tab.reload`                             | Tab.reload                                                        |
| `tab.Tab.evaluate`                           | Tab.evaluate / Frame.evaluate                                     |
| `tab.Tab.js_dumps`                           | evaluate + JSHandle.jsonValue（CDP 序列化边界）                   |
| `tab.Tab.close`                              | close                                                             |
| `tab.Tab.get_window`                         | Tab.windowBounds                                                  |
| `tab.Tab.get_content`                        | Tab.content                                                       |
| `tab.Tab.maximize`                           | Tab.windowBounds({windowState:"maximized"})                       |
| `tab.Tab.minimize`                           | Tab.windowBounds({windowState:"minimized"})                       |
| `tab.Tab.fullscreen`                         | Tab.windowBounds({windowState:"fullscreen"})                      |
| `tab.Tab.medimize`                           | Tab.windowBounds({windowState:"normal"})                          |
| `tab.Tab.set_window_size`                    | Tab.windowBounds({left,top,width,height})                         |
| `tab.Tab.activate`                           | Tab.bringToFront                                                  |
| `tab.Tab.bring_to_front`                     | Tab.bringToFront                                                  |
| `tab.Tab.set_window_state`                   | Tab.windowBounds                                                  |
| `tab.Tab.scroll_down`                        | Tab.mouse.wheel                                                   |
| `tab.Tab.scroll_up`                          | Tab.mouse.wheel                                                   |
| `tab.Tab.wait`                               | 显式条件等待 / `setTimeout`（node:timers/promises）               |
| `tab.Tab.wait_for`                           | waitForSelector / waitForFunction / waitForNavigation             |
| `tab.Tab.download_file`                      | Browser 下载流程 waitForDownload；或显式 fetch（Cookie 语义不同） |
| `tab.Tab.save_screenshot`                    | screenshot                                                        |
| `tab.Tab.set_download_path`                  | BrowserContext.setDownloadDirectory                               |
| `tab.Tab.get_all_linked_sources`             | queryAll("[src],[href]") + attribute/evaluate                     |
| `tab.Tab.get_all_urls`                       | evaluate 中 URL 解析                                              |
| `tab.Tab.get_local_storage`                  | Frame.storage                                                     |
| `tab.Tab.set_local_storage`                  | Frame.setStorage                                                  |
| `tab.Tab.get_frame_tree`                     | Tab.frames / cdp Page.getFrameTree                                |
| `tab.Tab.get_frame_resource_tree`            | Tab.resources                                                     |
| `tab.Tab.get_frame_resource_urls`            | Tab.resources 树中的 resources                                    |
| `tab.Tab.search_frame_resources`             | cdp Page.searchInResource                                         |
| `tab.Tab.verify_cf`                          | 有意排除自动挑战绕过承诺                                          |
| `tab.Tab.template_location`                  | 有意排除 OpenCV 图像匹配依赖                                      |
| `tab.Tab.bypass_insecure_connection_warning` | 有意不提供警告绕过；需自行显式配置 Security 域                    |
| `tab.Tab.mouse_move`                         | Mouse.move                                                        |
| `tab.Tab.scroll_bottom_reached`              | evaluate 中比较 scrollY/scrollHeight                              |
| `tab.Tab.mouse_click`                        | Element.click / Mouse.click                                       |
| `tab.Tab.mouse_drag`                         | Mouse.drag（指针拖动）                                            |
| `tab.Tab.flash_point`                        | 有意省略页面可见调试标记                                          |
| `element.Element.tag`                        | Element.describe() 的官方 DOM.Node 字段；不维护 Python 属性镜像   |
| `element.Element.tag_name`                   | Element.describe() 的官方 DOM.Node 字段；不维护 Python 属性镜像   |
| `element.Element.node_id`                    | Element.describe() 的官方 DOM.Node 字段；不维护 Python 属性镜像   |
| `element.Element.backend_node_id`            | Element.describe() 的官方 DOM.Node 字段；不维护 Python 属性镜像   |
| `element.Element.node_type`                  | Element.describe() 的官方 DOM.Node 字段；不维护 Python 属性镜像   |
| `element.Element.node_name`                  | Element.describe() 的官方 DOM.Node 字段；不维护 Python 属性镜像   |
| `element.Element.local_name`                 | Element.describe() 的官方 DOM.Node 字段；不维护 Python 属性镜像   |
| `element.Element.node_value`                 | Element.describe() 的官方 DOM.Node 字段；不维护 Python 属性镜像   |
| `element.Element.parent_id`                  | Element.describe() 的官方 DOM.Node 字段；不维护 Python 属性镜像   |
| `element.Element.child_node_count`           | Element.describe() 的官方 DOM.Node 字段；不维护 Python 属性镜像   |
| `element.Element.attributes`                 | Element.describe().attributes                                     |
| `element.Element.document_url`               | Element.describe() 的官方 DOM.Node 字段；不维护 Python 属性镜像   |
| `element.Element.base_url`                   | Element.describe() 的官方 DOM.Node 字段；不维护 Python 属性镜像   |
| `element.Element.public_id`                  | Element.describe() 的官方 DOM.Node 字段；不维护 Python 属性镜像   |
| `element.Element.system_id`                  | Element.describe() 的官方 DOM.Node 字段；不维护 Python 属性镜像   |
| `element.Element.internal_subset`            | Element.describe() 的官方 DOM.Node 字段；不维护 Python 属性镜像   |
| `element.Element.xml_version`                | Element.describe() 的官方 DOM.Node 字段；不维护 Python 属性镜像   |
| `element.Element.value`                      | Element.evaluate                                                  |
| `element.Element.pseudo_type`                | Element.describe() 的官方 DOM.Node 字段；不维护 Python 属性镜像   |
| `element.Element.pseudo_identifier`          | Element.describe() 的官方 DOM.Node 字段；不维护 Python 属性镜像   |
| `element.Element.shadow_root_type`           | Element.describe() 的官方 DOM.Node 字段；不维护 Python 属性镜像   |
| `element.Element.frame_id`                   | Element.describe() 的官方 DOM.Node 字段；不维护 Python 属性镜像   |
| `element.Element.content_document`           | Element.describe() 的官方 DOM.Node 字段；不维护 Python 属性镜像   |
| `element.Element.shadow_roots`               | Element.describe() 的官方 DOM.Node 字段；不维护 Python 属性镜像   |
| `element.Element.template_content`           | Element.describe() 的官方 DOM.Node 字段；不维护 Python 属性镜像   |
| `element.Element.pseudo_elements`            | Element.describe() 的官方 DOM.Node 字段；不维护 Python 属性镜像   |
| `element.Element.imported_document`          | Element.describe() 的官方 DOM.Node 字段；不维护 Python 属性镜像   |
| `element.Element.distributed_nodes`          | Element.describe() 的官方 DOM.Node 字段；不维护 Python 属性镜像   |
| `element.Element.is_svg`                     | Element.describe() 的官方 DOM.Node 字段；不维护 Python 属性镜像   |
| `element.Element.compatibility_mode`         | Element.describe() 的官方 DOM.Node 字段；不维护 Python 属性镜像   |
| `element.Element.assigned_slot`              | Element.describe() 的官方 DOM.Node 字段；不维护 Python 属性镜像   |
| `element.Element.tab`                        | Element.frame.tab                                                 |
| `element.Element.shadow_children`            | Element.queryAll（默认 pierce）                                   |
| `element.Element.save_to_dom`                | Element.evaluate（显式 DOM 修改）                                 |
| `element.Element.remove_from_dom`            | Element.evaluate(el=>el.remove())                                 |
| `element.Element.update`                     | 重新 query 获取有效元素；不复活旧文档句柄                         |
| `element.Element.node`                       | Element.describe                                                  |
| `element.Element.tree`                       | Element.describe / DOM.getDocument                                |
| `element.Element.attrs`                      | Element.describe().attributes                                     |
| `element.Element.parent`                     | Element.evaluate / DOM.describeNode                               |
| `element.Element.children`                   | Element.queryAll(":scope > *")                                    |
| `element.Element.remote_object`              | Frame.evaluateHandle                                              |
| `element.Element.object_id`                  | JSHandle.object.objectId（绑定文档代次）                          |
| `element.Element.click`                      | Element.click                                                     |
| `element.Element.get_js_attributes`          | Element.evaluate                                                  |
| `element.Element.apply`                      | Element.evaluate                                                  |
| `element.Element.get_position`               | DOM.getBoxModel / Element.evaluate(getBoundingClientRect)         |
| `element.Element.mouse_click`                | Element.click / Mouse.click                                       |
| `element.Element.mouse_move`                 | Mouse.move                                                        |
| `element.Element.mouse_drag`                 | Mouse.drag（指针拖动）                                            |
| `element.Element.scroll_into_view`           | cdp DOM.scrollIntoViewIfNeeded                                    |
| `element.Element.clear_input`                | Element.fill("")                                                  |
| `element.Element.send_keys`                  | focus + Keyboard.insertText                                       |
| `element.Element.send_file`                  | Element.upload                                                    |
| `element.Element.focus`                      | Element.focus                                                     |
| `element.Element.select_option`              | Element.select                                                    |
| `element.Element.set_value`                  | Element.fill / evaluate                                           |
| `element.Element.set_text`                   | Element.evaluate（显式 DOM 修改）                                 |
| `element.Element.get_html`                   | Element.html                                                      |
| `element.Element.text`                       | Element.text                                                      |
| `element.Element.text_all`                   | Element.text                                                      |
| `element.Element.query_selector_all`         | queryAll(css)                                                     |
| `element.Element.query_selector`             | query(css)                                                        |
| `element.Element.save_screenshot`            | screenshot                                                        |
| `element.Element.flash`                      | 有意省略可见调试特效                                              |
| `element.Element.highlight_overlay`          | cdp Overlay 域可选                                                |
| `element.Element.record_video`               | 有意不含编码器；CDP Page.startScreencast 可扩展                   |
| `element.Element.is_recording`               | 不提供高层录制会话                                                |
| `element.Position.to_viewport`               | 协议扩展或标准 TypeScript 数据结构；不提供同名封装                |
