# Third-party notices

## Coordinate conversion

The WGS84-to-GCJ02 numerical transformation in `web/map-coordinates.mjs` is adapted from [wandergis/coordtransform](https://github.com/wandergis/coordtransform). The inverse uses numerical iteration. These are approximate mathematical conversions, not an official coordinate conversion service.

The MIT License (MIT)

Copyright (c) 2015 记忆的残骸

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Maps

- AMap electronic tiles: © 高德地图. Tile URL documented in [Alibaba Cloud DataV basemap documentation](https://help.aliyun.com/en/datav/datav-6-0/user-guide/basemap-layer). Access follows the provider's availability and applicable terms; this is not the AMap JavaScript SDK.
- OpenStreetMap: © OpenStreetMap contributors, [ODbL](https://www.openstreetmap.org/copyright). Browser tile caching and visible attribution are retained. No offline download or prefetch feature is provided.
- pymobiledevice3: GPL-3.0-or-later, installed separately from PyPI.
- Place-name search defaults to Nominatim / OpenStreetMap, ODbL attribution is shown with search results. Requests are explicitly initiated, cached, and rate limited. AMap POI search is available with a separately supplied Web service Key.
- certifi: Mozilla Public License 2.0, installed separately from PyPI; used to supply public certificate authorities for verified HTTPS requests.
