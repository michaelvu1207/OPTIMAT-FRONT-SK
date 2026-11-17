# 待团队确认：首次使用与预约信息

核对日期：2026-11-17。用途：供项目团队／CCTA 与服务商确认；本清单不构成数据库更新。

## 本次已核实

- 通过生产公开 API 只读查询，LINK Paratransit（2006）与 Mobility Matters（4021）的 `booking.application.source_url` 已有官方入口；这两家的申请资料不是全部缺失。
- LINK 记录已包含申请要求、完整申请收到后 21 天内处理、官方申请说明网址。官网当前链接的 2026 年 9 月版申请包也写明完整申请收到后 21 天内处理。这不等于必须等待满 21 天、保证获批或保证有车。
- Mobility Matters 记录已有申请／联系协调员入口及说明，但没有明确的 `application.required` 或处理时长。官网引导潜在乘客填写表格或拨打 925-284-6161，再由协调员联系；所查页面未明确完整审核流程和处理期限。
- 网址可访问性：Mobility Matters 申请页直接请求返回 HTTP 200，页面包含联系号码。LINK 对脚本请求返回 HTTP 403，但用 Edge 浏览器访问返回 HTTP 200，页面标题、申请说明、申请电话和 21 天处理信息均存在。403 不代表该网址失效；也不能据此保证所有用户网络都能访问。
- 申请入口功能直接读取现有记录，不在代码里按服务商名称写死链接，不创建新字段或覆盖现有数据。未知申请时长继续显示联系服务商确认。

## 待确认问题

| 服务／事项 | 现有记录与核对范围 | 请团队／服务商确认 | 确认前处理 |
| --- | --- | --- | --- |
| Mobility Matters：首次使用流程 | 官网提供表格、电话和协调员回访；没有明确完整审核步骤 | 首次乘车前是否必须完成正式申请、登记、评估或批准？分别有哪些步骤？ | 不把联系表格推断为正式审批要求，也不填写“不需要申请” |
| Mobility Matters：处理时长 | 所查申请页、老人及退伍军人项目页未公布时长 | 一般处理多久？从收到表格、完成材料还是评估结束开始计时？自然日还是工作日？ | 保留未知；不填 7 天或 30 天 |
| Mobility Matters：预约提前量 | 生产记录为 `7 days`；本次所查官网页面未找到该数字的佐证 | 7 天是否仍适用？最低提前量还是建议？自然日还是工作日？两个项目是否相同？ | 暂不更改已有记录；标为待重新核实，不能当成申请时长 |
| Mobility Matters：接收新乘客与候补 | 本次未取得当前可接收状态或候补信息 | 是否接收新乘客？是否有候补名单？等待多久？谁负责更新？ | 不表示已经有候补，也不承诺立即接收或有车 |
| 联系方式的用途 | LINK 申请咨询 925-680-2138；预约 925-938-7433。Mobility Matters 首次联系 925-284-6161 | 其他服务商是否有独立的首次申请咨询电话？谁负责定期核对？ | 普通服务商电话仅标为咨询首次使用，不称作申请专线 |

## 来源与范围

- LINK 官方申请说明：https://countyconnection.com/paratransit/eligibility-registration/
- LINK 当前官网链接的申请包（2026 年 9 月）：https://countyconnection.com/wp-content/uploads/2026/09/ADA-Application-Updated-09.26.pdf
- LINK 预约说明：https://countyconnection.com/paratransit/making-a-reservation/
- Mobility Matters 申请／联系页：https://mobilitymatterscc.com/become-a-client/
- Mobility Matters 老人项目：https://mobilitymatterscc.com/senior-rides/
- Mobility Matters 退伍军人项目：https://mobilitymatterscc.com/rides-4-veterans/
- 生产公开查询：`GET https://api.optimat.us/providers/search?q=LINK` 与 `?q=Mobility%20Matters`。

未致电、未发送邮件、未提交申请表。网站和记录核对不证明电话一定有人接听，也不证明实时司机可用性。上述未查到的内容只表示本次查阅范围内未找到，并非断言该信息不存在。

后续发现的未核实事项继续追加到本清单；每项保留现有记录、来源、具体疑问和确认前处理，避免默认值或推断混入正式数据。
