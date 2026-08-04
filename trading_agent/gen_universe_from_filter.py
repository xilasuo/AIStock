import json, re, sys

# 主选数据源：腾讯自选股 tool_filter (preset=low_pe, max_pe=300, limit=120)
# 来源确认：2026-08-03 运行返回 114 只
RAW = """sz000656
sz002582
sh600841
sz000498
sh601997
sh600015
sh601577
sz002611
sh603323
sh601186
sh601818
sh601668
sh601166
sh601528
sz000001
sh601336
sh600502
sh601390
sh601169
sh601128
sh600908
sh600016
sz002807
sh601229
sz002958
sz002839
sh601838
sh601601
sh600926
sh601077
sh600919
sh601998
sh600928
sz000885
sh600036
sh688648
sh601825
sz002612
sz000544
sh601963
sz002966
sh601658
sz001227
sz002142
sh601717
sh600704
sh601117
sh600741
sh688330
sz000913
sh601628
sz000685
sh601318
sh601319
sh601398
sz002758
sz000600
sh601800
sh601187
sh600064
sz000651
sh601988
sh601860
sz000623
sh601939
sh600970
sh601288
sh600011
sh600820
sz000933
sz002608
sh600853
sz000543
sh600720
sz002772
sh600269
sz002936
sz000151
sh600210
sh600018
sh600023
sh601669
sz000726
sh600987
sz000612
sz300724
sz000589
sh600861
sh601677
sz000987
sz002588
sh600098
sh603368
sh601919
sh600894
sz000719
sh600027
sh600873
sz300926
sz002668
sz002736
sz002572
sh601811
sh603558
sh601156
sz002532
sh600874
sh601898
sh600461
sh601688
sh601083
sh603799
sh600096
sz002061"""

codes = []
seen = set()
for line in RAW.strip().splitlines():
    c = line.strip()
    if not c:
        continue
    num = re.sub(r'^(sh|sz|bj)', '', c)
    if num in seen:
        continue
    seen.add(num)
    codes.append(num)

out = {"universe": codes, "index": "000300"}
with open("market_universe.json", "w", encoding="utf-8") as f:
    json.dump(out, f, ensure_ascii=False, indent=2)

print(f"universe size = {len(codes)}")
print("first 5:", codes[:5])
print("last 5:", codes[-5:])
