# 战术文本格式 v1

目标：**每个教学条目是一份 YAML 文本，同一套网页读取这些数据，画出站位、路线和职责，并按同一规则播放。** PDF 是可选的资料来源；条目没有 PDF、页码或原图时也能完整运行。

内置的 64 个教学条目与导入内容均使用这套格式，经过相同的校验与渲染入口。[在线应用](https://titanxxh.github.io/flagventures/)和本地网页均保留全部条目；公开仓库与默认应用不包含原页图片，也不依赖 PDF。下文的来源图片字段供自行维护的内容包按需使用。

## 可直接查看的文件

- [自编战术模板](templates/new-play.yaml)：没有 PDF 来源，复制后填写自己的战术。
- [SINGLE BACK PLAY 1](examples/single-back-play-1.yaml)：现有第 7 页进攻样例的独立文本。
- [COVER 2](examples/cover-2.yaml)：现有第 59 页防守样例，区分区域、职责与跑动。
- [曲线、停顿与分支](examples/route-variants.yaml)：自编的格式能力演示，不是附件 OPTION 的战术解释。
- [样例目录](catalog.yaml)及[四条样例的完整内容包](examples.flagbook.json)：演示单条维护与整包保存的对应关系，不是全书数据。

## 1. 家长以后怎样新增战术

1. 复制 [新战术模板](templates/new-play.yaml)，改成自己的文件名。
2. 填写编号、标题、每人的起点、路线和讲解文字；需要错开行动时，修改各人的 `startAt` 与动作时长。
3. 打开在线应用或本地网页，在“我的战术文件”中点“导入 YAML / 战术包”，选择一个或多个 `.yaml` 文件；核对预览后加入“我的战术”。修改已有编号的文件时，导入预览会显示“更新”，由家长应用更改。
4. 点“保存完整战术包”，保存当前所有战术内容；下次打开网页后导入该包即可恢复内容。

这条流程保存的是**教学内容**，不记录孩子学了什么。普通网页不会自动扫描旁边文件夹，也不会自动回写原 YAML。导入后的更改只在本次打开中生效，下载新包才有可再次打开的文件；原始 YAML 仍可作为长期维护的文本。

维护者可以把同样的 YAML 打包成新的单文件 HTML，变成下次双击即有的默认内容。日常新增使用导入按钮，不要求家长重新构建应用。内置手册目录保留原书顺序，新增内容默认放在其后的“我的战术”。

## 2. 文件与统一渲染的关系

| 文件 | 用途 |
| --- | --- |
| 每条 `*.yaml` | 人可维护的教学条目；包括数据和中文讲解，不写页面代码 |
| `lesson.schema.json` | 机器可检查的结构约定，避免漏字段、拼错字段和类型错误 |
| `catalog.yaml` | 默认书目顺序与可选分组；按编号引用内容文件，不依赖 PDF 页码排序 |
| `*.flagbook.json` | 网页导出的完整内容包，内含条目、顺序、可选分组与可选原页图片；下次整包导入 |
| 网页渲染器 | 负责图形、样式、悬停、播放和暂停；依据内容类型选择相应呈现 |

YAML 便于加中文注释和逐行编辑；JSON 内容包便于可靠导出。二者解析后使用同一份数据结构。格式固定 `version: 1`，未知版本报告不支持，不能悄悄按当前版本解释。

## 3. 一个条目写哪些内容

| 字段 | 含义 |
| --- | --- |
| `format` / `version` | 固定为 `flag-lesson` / `1` |
| `id` | 永久编号，例如 `single-back-play-1`；改标题不改编号 |
| `kind` | `route` 基础路线、`formation` 静态阵型、`offense` 进攻战术、`run` 跑球战术、`defense` 防守方案 |
| `title.zh` / `title.en` | 中文标题与英文标题；英文可省略，自编内容不强求英文名 |
| `summary` | 一两句中文讲解目标 |
| `teaching` | 可省略的全队讲解：目标 `goal`、配合 `cooperation`、记忆口令 `cue`、提问 `question` |
| `source` | 可省略的出处：`title`、可选 `page`、`note`、`references`、`referenceAsset`；`referenceAsset` 是内容包内的图片编号，不是磁盘路径 |
| `field` | 画布尺寸、进攻方向和可选开球线位置 |
| `players` | 稳定身份、起点、悬停说明与各自的动作 |
| `zones` / `assignments` | 可省略的防守区域与分工关系；与人物跑动分开 |
| `timeline` | 演示总时长及其依据，明确是否为教学示意 |
| `keyframes` | 适合停住讲解的书签与提示，可附教学显示范围 |
| `notes` | 可省略的补充说明列表 |

所有标识符使用英文字母开头的字母、数字、短横线或下划线，最长 64 字符。显示名称可以使用中文。队员 ID 在本条目内唯一，战术 ID 在整个内容包内唯一；颜色只是显示辅助。

### 全队讲解与可核对的来源

```yaml
teaching:
  goal: 给短路线的队友腾出接球空间。
  cooperation: 深跑队员把防守带远，短跑队员在近处寻找空当。
  cue: 我跑深，队友接近球。
  question: 谁的跑位帮助了短路线队友？
source:
  title: NFL FLAG 官方战术介绍
  references:
    - title: 官网 Bunch 阵型讲解
      url: https://nflflag.com/coaches/flag-football-rules/5-on-5-flag-football-playbook
      locator: Bunch · Play 1
      note: 说明深浅路线怎样配合；具体动画秒数由教学编写。
```

这是讲解字段示例，不能代替完整战术的站位与动作数据。`teaching` 整个对象可省略；填写时四个字段都必填。`source.references` 可省略或为空；每条参考必填 `title`、`url`，可选 `locator`（网页小节、视频时间等）与 `note`（该来源支持什么）。链接须为有效的完整 HTTP/HTTPS 网页地址，不含用户名、密码、空白或控制字符；不接受 `javascript:`、`data:`、磁盘路径等。链接只在主动打开时访问，条目运行不依赖联网。

新增的讲解文字、参考标题、定位和说明均须为非空白短文本，每项最多 500 字符，URL 最多 2048 字符。字段内容按普通文字显示。参考链接、讲解与可选原页图片相互独立；有官网或视频说明也可以保留原 PDF 页码，说明不同资料各自支持的事实。

## 4. 坐标容易统一，也不冒充真实码数

例子使用宽 `100`、高 `55` 的画布：`[0, 0]` 在左上，x 越大越向右，y 越大越向下。`attackDirection: up` 表示向上进攻，`down` 表示向下进攻；方向用于箭头与讲解，**不会自动镜像数据**。

`at: [20, 35]` 表示队员在画布的 x=20、y=35 处。尺寸可改；所有点、曲线控制点和覆盖区域应位于画布内，若图形越界应调整画布或数据，不静默裁掉路线。这些是绘图单位，不能解释成码数或真实跑动距离。

原书样例保留各页形状、方向和相对站位；不根据“某类标准阵型”统一重置各页站位。

`field` 必填 `width`、`height`、`attackDirection`；`lineOfScrimmageY` 可省略，表示开球线的 y 坐标。只有存在此字段时才画开球线。

## 5. 球员、术语和动作

```yaml
- id: X
  team: offense
  at: [20, 35]
  label:
    en: Slant
    zh: 短斜内切
    description: 先向前跑一小段，再斜着往中间跑。
    basis: author
  motion:
    type: path
    startAt: 0
    steps:
      - {type: line, to: [20, 28], seconds: 1}
      - {type: line, to: [38, 20], seconds: 2}
```

这里是自编的**格式说明示例**，不是附件某页的精确路线。文字 `Slant` 只决定显示内容，不触发隐藏的自动路线生成。

每名球员必填 `id`、`team`、`at`、`label`、`motion`；可选 `name`、十六进制 `color` 与 `coaching`。`team` 为 `offense` 或 `defense`。基础路线可只有一名示范球员；防守图可含双方，不能把所有条目写死为五个标记，也不能强制每个防守方案都有 R。手册原有条目的人数仍按逐页清单核验。

`coaching` 填写该球员怎样帮助队友，以及怎样理解启动时机；填写时两个字段均必填，每项最多 500 字符且不能只填空白：

```yaml
coaching:
  cooperation: 我往深处跑，给中锋的短路线留空间。
  timing: 来源未规定我的启动先后；动画共同起步只是教学安排。
```

它与 `label.description` 分工不同：后者描述怎样跑，`coaching` 描述怎样配合。讲解文字不自动生成或改变路径、等待时间与触发条件。

`color` 支持 `#RGB`、`#RGBA`、`#RRGGBB`、`#RRGGBBAA`；省略则由页面分配可区分的颜色。颜色不能用于查找队员或决定路径归属。

### 悬停标签的依据

`label` 必填 `zh`、`description`、`basis`，英文 `en` 可省略；可选 `note` 解释具体依据。

| `basis` | 解释 |
| --- | --- |
| `source` | 来源明确给这个对象命名；必须填写可识别的 `source` |
| `shape-match` | 把完整路径与已知路线形状对照；必须填写 `label.note` 说明对照对象，不显示成原页明确命名 |
| `description` | 按图描述，不冒充标准术语，例如“后场向左路线” |
| `author` | 作者为自编内容填写的名称或说明 |
| `unspecified` | 资料没有说明该角色的跑法 |

### 动作四种情况

| `motion.type` | 字段和含义 |
| --- | --- |
| `unspecified` | 必填 `note`。只显示已知起点，后续动作未知；不表示必须站住 |
| `still` | 必填 `note`。作者或来源明确要求这次示意全程原地停留；与未知不同 |
| `path` | `startAt` 加 `steps`。先在起点等到启动时间，再依次执行动作段 |
| `choice` | `startAt`、`prompt`、至少两条 `options`；每个选项有 `id`、`title`、`steps`，可选非空短文本 `note`。表示互斥的完整备选路线或教学情形 |

动作段支持：

- `line`：`to`、`seconds`，沿直线到下一点。
- `quadratic`：`control`、`to`、`seconds`，沿二次曲线移动。
- `cubic`：`control1`、`control2`、`to`、`seconds`，沿三次曲线移动。
- `pause`：只有 `seconds`，在当前点停顿。

每段的起点由上一段终点确定，第一段从 `at` 开始；没有允许人物瞬移的 `from` 字段。暂停段不产生新路径。所有时长必须为正数；`startAt` 必须非负。路线走完后保留最后画面，说明应保持“演示路线结束”的含义，不推断真实比赛中随后站住。

曲线段按该段弧长均匀推进；不能把不同类型的曲线参数直接当作匀速距离。路线方向以实际坐标为准，内切、外切不等于固定向左、向右。

### OPTION 与条件释放的处理

每个选项都从同一个队员起点开始，包含完整路线；不要把分支串成先跑 A、再跑 B。没有选演示分支时显示各条备选线和原站位，允许查看说明；播放和非零时间跳转等待选择分支。分支选择不是“比赛正确答案”，也不隐含防守判断。选择或更换分支后整场回到起点并暂停。

选项 ID 在各球员内部唯一，运行时用“球员 ID＋选项 ID”识别。若有多名球员带 choice，全部选好才可播放或跳到非零时间；更改其中一人的选择只替换该人的选项，其他人的选择保留，整场回到 0 秒并暂停。切换条目清除选择。导出始终保存所有备选路线，不保存本次临时选择。

来源写“若其他人没有空位，中锋再释放接应”时，可用同一 `choice` 表达两种情形，不能将它简化为每次固定延迟起跑。以下仅示范数据写法，10 秒时间轴与等待 2 秒均为教学安排：

```yaml
motion:
  type: choice
  startAt: 0
  prompt: 这次要演示哪种接应情形？
  options:
    - id: release
      title: 其他队友没有空位，释放接应
      note: 先观察再出发；2 秒等待只是方便讲解，不是来源规定。
      steps:
        - {type: pause, seconds: 2}
        - {type: line, to: [50, 10], seconds: 8}
    - id: not-triggered
      title: 不演示释放接应
      note: 资料未交代此时的后续跑动；标记留在起点只表示不演示，不能理解成比赛中必须站住。
      steps:
        - {type: pause, seconds: 10}
```

必须先由家长选择情形，再观看整场动画；未选择时全队停在 0 秒。选择表达教学情形，不会自动检测防守、判断是否有空位或生成传球。每个选项的 `note` 用于说明条件与未展示部分，不能省略事实上的未知。未知动作通常使用 `unspecified`；这里只为保留一个条件分支，用暂停与说明共同表达“不演示该分支的后续动作”。

## 6. 怎样写“谁先跑、谁后跑”

**采用唯一一种计时办法：统一时间轴＋个人启动时间＋有序动作段时长。** 不另加“等另一人触发”的脚本或依赖表达式。

```yaml
timeline:
  duration: 8
  basis: illustration
  note: 为讲解错开启动；不是比赛规定。

# 在两名球员各自的 motion 中分别填写：
# X: startAt: 0
# Y: startAt: 1.5
```

这表示 X 在 0 秒开始、Y 在 1.5 秒开始。`pause` 可表达同一路线内部的停顿。原 PDF 没有明确的跨球员起跑先后；补充的 NFL FLAG 官网与视频则对部分战术说明了相对先后、短暂等待或条件释放。默认进攻条目据此分别写入球员说明、启动时间或互斥情形，且保留出处。具体动画秒数仍按教学示意标注，不能从线条长短、路线交叉或解说逐人介绍的顺序生成真实时序。

`timeline.basis` 可取 `illustration`（教学示意）、`source`（来源给定）、`coach`（教练提供）；`note` 必填。后两种须填写可识别的 `source`，说明时间来自哪里。总时长不得短于任一路线的 `startAt + 各段 seconds 总和`，CHOICE 要检查所有备选路线；不能静默截断路线。

`formation` 的总时长固定为 0，动作只能为 `unspecified` / `still`，只需 0 秒书签。防守分步讲解可有显示用时间轴，同时人物保持静态，依据仍为教学示意。

## 7. 关键帧只标讲解位置

```yaml
keyframes:
  - id: start
    at: 0
    label: 起始站位
    cue: 找到自己和四名队友。
  - id: turn
    at: 3
    label: 看转向
    cue: 指一指你和队友接下来去哪里。
```

第一帧必须在 0 秒，后续时间严格递增，且不超过 `timeline.duration`。关键帧不是视频截图，也不存另一套球员位置；点击后由条目、统一时间及所选分支直接算出全队位置并暂停，前后跳转得到同样结果。

可选 `view: {zoneIds: [...], assignmentIds: [...]}` 用于防守讲解中的逐步显示。它只过滤教学图层，不规定人物动作。任意时刻取“不晚于当前时刻的最后一个关键帧”的显示设置：该帧没有 `view` 则显示全部区域和分工；有 `view` 时两个列表都必须给出，空列表表示隐藏。设置不从前一帧累积，向后拖动也能重建相同画面。

## 8. 防守职责独立表达

`zones` 是区域，用 `type: ellipse`（`center`、`radiusX`、`radiusY`）或 `type: polygon`（至少三个 `points`）区分形状。每区有唯一 `id` 和中文 `label`。区域不会驱动球员沿边界跑动。

`assignments` 每项含 `id`、`type`、`player`：

- `coverage` 另填 `zone`，表示负责哪个区。
- `matchup` 另填 `target`，表示盯哪名球员。
- `rush` 表示原图明确的冲传方向指示，必填 `guide`。

`guide` 是静态指示线：`from` 加 `segments`。段支持 `line` / `quadratic` / `cubic`，字段同动作段的几何部分，**没有秒数、没有 pause**。coverage / matchup 的 guide 可省略；省略时仅展示职责文字/高亮，不擅自连一条中心到中心的线。rush 的 guide 只画箭头，不让队员自动沿它追逐。

球权变化不由以上任何字段推断。v1 不引入传球、真假交接或动态跟防脚本；有明确的局部动作说明可写在讲解文字中，扩展动画需另行设计可验证的数据语义。

## 9. 导入、目录和内容包

- 一个 `.yaml` 文件只放一个条目；允许一次选择多个文件。按可安全解析的数据子集读取，不支持自定义标签、锚点/别名、合并键或可执行表达式。建议给名称与说明字符串加引号；UTF-8 保存。
- 先全部解析与校验，再显示预览并一次应用；取消或出错不改动当前目录。报错应指明文件、球员和字段，例如“X 的第 2 段 seconds 必须大于 0”“D2 引用的区域 deep-left 不存在”。
- 不认识的字段与版本报错；数值必须有限。检查坐标边界、重复 ID、悬空引用、时间超界、分支遗漏；不能把错误当作默认值悄悄运行。
- 本地源文件目录按 `catalog.yaml` 的章节和 entries 数组决定顺序；文件名仅用于维护和构建，不要求页面用 `fetch` 读取相邻文件。构建时核对引用文件的条目 ID。
- `catalog.yaml` 固定 `format: flag-catalog`、`version: 1`，`title` 为字符串，`sections` 每项含 `id`、`title`、`entries`，可选 `groups`；每个 entry 含 `id` 和相对路径 `file`（`.yaml` / `.yml`）。路径相对该 catalog，不能是绝对路径、URL 或含 `..` 的上级目录跳转。
- 网页导出的 `flag-playbook` 包含 `version: 1`、`title`、完整 `lessons` 数组与 `sections` 数组。每个 section 含 `id`、`title`、有序 `lessonIds`，可选 `groups`；每个条目在各章节的顶层 `lessonIds` 中合计恰好出现一次。分组中的 ID 是对这些条目的引用。书目和内容不可失配。
- 包、section 和 group 的 `title` 都是字符串；只有教学条目的 `title` 是含 `zh` 与可选 `en` 的对象。
- 可选 `assets` 为图片列表，每项含 `id`、`mime`（PNG 或 JPEG）、`base64`。`source.referenceAsset` 按 ID 找图；缺图只提示原页对照不可用，不影响站位与路线渲染，不访问外部磁盘路径或网络地址。
- 新增条目默认追加到“我的战术”，保留内置手册顺序。同 ID 导入显示为更新，不产生第二份同编号；预览说明哪些条目会更新，应用后导出当前完整包保存。导出的包可以再拆成 YAML 维护，语义一致，原 YAML 注释不承诺往返保留。
- 单条 YAML 更新采用**整条替换、保留原目录位置**；新文件省略的可选字段会移除，不与旧值合并。同一批导入文件内部重复 ID 报错，不能按文件顺序相互覆盖。
- “载入战术包”采用**整包替换本次活动库**，使用包中完整 lessons 与 sections，不与当前目录合并；应用前预览说明这一效果。程序自带的默认手册仍保留，重新打开网页或选择内置手册可以回到它。完整收录与原书顺序的验收针对默认库；作者自行载入的包按自己的 sections 展示，不被程序暗中重排。
- 普通内容文件只解析数据，文字按文字显示。建议单条文本不超过 1 MB、整包不超过 50 MB；超限先提示，不尝试部分导入。解析器、校验器和渲染器均随 HTML 打包，不在使用时联网下载。

### 目录的可选分组

章节的 `groups` 每项包含 `id`、`title`、`lessonIds`，只增加可折叠的目录层级。`catalog.yaml` 中原有 `entries` 必须保留；打包后的章节仍保留完整、有序的 `lessonIds`，并复制相同的 `groups`。例如：

```yaml
format: flag-catalog
version: 1
title: 我的战术目录
sections:
  - id: offensive-formations
    title: 进攻阵型与战术
    entries: # 保留原有条目和顺序
      - {id: single-back-formation, file: lessons/single-back-formation.yaml}
      - {id: single-back-play-1, file: lessons/single-back-play-1.yaml}
      - {id: single-back-play-2, file: lessons/single-back-play-2.yaml}
      - {id: single-back-play-3, file: lessons/single-back-play-3.yaml}
    groups:
      - id: single-back
        title: 单跑卫阵型
        lessonIds:
          - single-back-formation
          - single-back-play-1
          - single-back-play-2
          - single-back-play-3
```

同一章节内分组 ID 唯一，每组至少包含一个条目；成员必须属于本章、按章节顺序连续排列，且不能重复或属于多个组。允许保留未分组条目。分组不替代或重排原目录，也不依赖 PDF、页码或标题推断；默认库的 10 个阵型组由目录明确配置。

新增战术可不分组，不含 `groups` 的旧目录和战术包仍在可折叠的章节内按普通列表显示。章节本身的展开与收起不需要额外字段。单条教学 YAML 不写 `groups`；直接导入的新条目默认追加到「我的战术」。网页导出完整包时保留分组配置；展开或收起的临时状态不属于教学内容。

## 10. 校验与格式维护

在项目根目录运行 `npm test`，会重新读取默认目录和 YAML，检查结构、引用、坐标、时长、分支与内容完整性，并验证统一场景计算。`npm run test:browser` 使用 Chrome 检查本地网页的显示、播放及导入导出。

`teaching`、`player.coaching`、`source.references`、`choice.options[].note` 是格式版本 1 的可选补充；不含这些字段的已有 YAML、目录和内容包继续有效，不需要迁移。导入更新仍为整条替换；导出保留所有这些字段与完整分支，不保留本次选择、播放位置等临时状态。

扩展格式时应明确更新版本约定并提供迁移说明，不能悄悄改变已有字段含义。保持同一内容、同一时间和同一分支选择始终得到相同画面。

## 中英文文字（可选）

中文仍填写在原字段中；英文放在 `translations.en`。路径中的球员、关键帧、选项使用其 `id`，不使用数组位置，因此调整球员顺序不会让译文错位。

```yaml
translations:
  en:
    title.zh: My first play
    summary: X cuts inside while teammates create space.
    teaching.goal: Make room for an inside pass.
    players.X.label.zh: Slant
    players.X.label.description: Run forward, then cut toward the middle.
    keyframes.start.label: Starting positions
    keyframes.start.cue: Find your starting position.
```

只填写实际存在的文字字段；未提供译文时显示原文（英文标题也可沿用 `title.en`）。支持名称、摘要、全队教学提示、球员名称及跑法说明、配合与时机、条件选项文字、关键帧、区域名称、备注和来源说明。`notes.0` 与 `source.references.0.title` 使用从 0 开始的序号。内置 YAML 提供完整示例。

章节及分组可填写 `titleEn`。路线坐标、球员 ID、时间、分支 ID 和来源网址由两种语言共用，不能写进翻译表。无效字段会在导入时指出。导出 YAML 和完整战术包均保留两种语言，切换界面语言不会改写原数据。
