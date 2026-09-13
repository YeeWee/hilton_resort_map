# Hilton Resort Map

把 Hilton 官方 "Resort Credit Eligible Hotels" 页面列出的酒店呈现在一张 Leaflet 地图上:品牌决定配色与图例筛选,侧边栏按大洲 → 国家 → 酒店组织。数据全集就是该页面列出的全部酒店,不多不少。

## Language

**Resort Credit Eligible Hotel(合格酒店)**:
Hilton 官方页面上被列为可用 Hilton Honors Resort Credit 的酒店。本项目的数据全集 = 该页面列出的全部酒店。
_Avoid_: 度假村(页面含非 resort 类型的酒店)、eligible hotel

**Brand(品牌)**:
Hilton 旗下酒店品牌,以页面 "by hotel brand" 分组为准(Conrad、Curio、DoubleTree 等)。决定 marker 配色与图例筛选。
_Avoid_: 集团(Hilton 是唯一集团,品牌才是分组单位)

**Region(地区)**:
页面 "by region" 分组使用的分区,实际取值为 Americas、Asia Pacific、Europe、Middle East、Africa(个别酒店无值)。仅作为单个酒店的一条展示属性(popup),不是分组或筛选维度。
_Avoid_: 大洲、国家(Middle East、Americas 等是 Hilton 自己的分区口径,不是大洲,也不等于国家)

**Country(国家)**:
酒店物理所在的国家,按酒店坐标所在的地理位置判定,不是 Hilton 官网字段。侧边栏"按大洲和国家"组织的分组维度;个别酒店可能判定不出,归入"未标注国家"。
_Avoid_: Region(两者口径独立:同一家酒店的 Region 与 Country 不互相推导、可能不一致)

**Continent(大洲)**:
标准大洲口径(亚洲、欧洲、非洲、北美洲、南美洲、大洋洲),由 Country 派生;侧边栏分组的顶层维度。
_Avoid_: 地区/Region(Middle East、Asia Pacific 等官网分区不是大洲)
