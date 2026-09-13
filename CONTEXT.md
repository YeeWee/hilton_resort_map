# Hilton Resort Map

把 Hilton 官方 "Resort Credit Eligible Hotels" 页面列出的酒店,按品牌呈现在一张 Leaflet 地图上。数据全集就是该页面列出的全部酒店,不多不少。

## Language

**Resort Credit Eligible Hotel(合格酒店)**:
Hilton 官方页面上被列为可用 Hilton Honors Resort Credit 的酒店。本项目的数据全集 = 该页面列出的全部酒店。
_Avoid_: 度假村(页面含非 resort 类型的酒店)、eligible hotel

**Brand(品牌)**:
Hilton 旗下酒店品牌,以页面 "by hotel brand" 分组为准(Conrad、Curio、DoubleTree 等)。地图上的主要分组维度。
_Avoid_: 集团(Hilton 是唯一集团,品牌才是分组单位)

**Region(地区)**:
页面 "by region" 分组使用的地理分区(如 United States、China)。仅作为单个酒店的一条展示属性,不是地图的分组维度。
_Avoid_: 国家、城市(region 是 Hilton 自己的分区口径,不等于国家)
