"""Focused UI acceptance tests. Requires Playwright and an installed Chrome.

Run: python tests/browser/ui_preview.py [--screenshots DIR]
Always launches an isolated demo server and temporary favorites database.
"""
import argparse
import json
import os
from pathlib import Path
import queue
import re
import subprocess
import sys
import tempfile
import threading
import time

from playwright.sync_api import sync_playwright, expect

ROOT=Path(__file__).resolve().parents[2]

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--screenshots',type=Path)
    args=parser.parse_args()
    if args.screenshots: args.screenshots.mkdir(parents=True,exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='waypoint-ui-') as folder:
        server=subprocess.Popen([os.environ.get('PYTHON',sys.executable),str(ROOT/'app.py'),'--demo','--no-browser','--data-dir',folder],cwd=ROOT,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True)
        output=queue.Queue()
        threading.Thread(target=lambda:[output.put(line) for line in server.stdout],daemon=True).start()
        try:
            deadline=time.monotonic()+25
            url=None
            while time.monotonic()<deadline:
                line=output.get(timeout=max(0.1,deadline-time.monotonic()))
                match=re.search(r'http://127\.0\.0\.1:\d+/#token=[\w-]+',line)
                if match: url=match[0];break
            assert url,'Demo did not start'
            with sync_playwright() as p:
                browser=p.chromium.launch(headless=True,**({'executable_path':os.environ['CHROME_BIN']} if os.environ.get('CHROME_BIN') else {'channel':'chrome'}))
                page=browser.new_page(viewport={'width':1440,'height':900},device_scale_factor=1)
                errors=[]
                page.on('pageerror',lambda e:errors.append(str(e)))
                page.on('dialog',lambda d:d.accept())
                page.goto(url,wait_until='networkidle',timeout=60000)
                expect(page.locator('#devices')).to_have_value('demo-only')
                snapshot=lambda:page.evaluate("fetch('/api/status',{headers:{Authorization:'Bearer '+sessionStorage.getItem('waypoint-token')}}).then(r=>r.json())")
                assert snapshot()['demo'] is True
                expect(page.locator('#route-section')).to_be_hidden()
                expect(page.locator('#motion-section')).to_be_hidden()
                expect(page.locator('#apply')).to_have_text('连接设备')
                page.locator('#apply').click()
                expect(page.locator('#apply')).to_have_text('绘制路线')
                assert not page.locator('#device-section').evaluate('e=>e.open')
                page.locator('#apply').click()
                expect(page.locator('#route-empty')).to_be_visible()
                expect(page.locator('#motion-section')).to_be_visible()
                expect(page.locator('#apply')).to_be_disabled()
                route={'version':1,'coordinateSystem':'WGS84','points':[[38,114.52],[38.001,114.52],[38.001,114.521],[38,114.521]],'closed':True,'laps':2,
                       'motion':{'mode':'speed','speed':5.4,'drift_enabled':True,'drift_radius_meters':2}}
                def import_route(doc):
                    page.locator('#route-file').set_input_files({'name':'ui-preview.json','mimeType':'application/json','buffer':json.dumps(doc).encode()})
                    expect(page.locator('#point-count')).to_have_text(str(len(doc['points'])))
                def shot(name):
                    page.wait_for_function("!document.getElementById('map-view').textContent.includes('NaN') && Number(document.getElementById('map').dataset.loadedTiles)>0 && document.getElementById('map').dataset.loadedTiles===document.getElementById('map').dataset.totalTiles",timeout=25000)
                    if args.screenshots:page.screenshot(path=str(args.screenshots/(name+'.png')),full_page=True)
                import_route(route)
                page.locator('#save-route-favorite').click()
                page.locator('#favorite-name').fill('UI 测试示例路线')
                page.locator('#favorite-submit').click()
                expect(page.locator('#favorites-notice')).to_contain_text('收藏已保存')
                page.locator('#favorites-close').click()
                page.locator('#apply').click()
                expect(page.locator('#apply')).to_have_text('暂停')
                expect(page.locator('#load-active-route')).to_be_enabled()
                before=snapshot()
                assert before['motion']['speed']==5.4
                page.locator('#mode-point').click()
                expect(page.locator('#route-section')).to_be_hidden()
                expect(page.locator('#point-section')).to_be_visible()
                expect(page.locator('#motion-section')).to_be_hidden()
                expect(page.locator('#apply')).to_have_text('暂停')
                page.locator('#apply').click()
                expect(page.locator('#apply')).to_have_text('继续')
                paused=snapshot()
                page.locator('#mode-route').click()
                page.locator('#drift-radius').evaluate("e=>{e.value='4.1234';e.dispatchEvent(new Event('input',{bubbles:true}));}")
                expect(page.locator('#drift-radius')).to_have_value('4.1')
                page.locator('#drift-radius').evaluate("e=>{e.value='4';e.dispatchEvent(new Event('input',{bubbles:true}));}")
                expect(page.locator('#motion-change-title')).to_have_text('有未应用的设置')
                expect(page.locator('#motion-change-detail')).to_contain_text('2 米 → 4 米')
                assert snapshot()['motion']['drift_radius_meters']==2
                page.locator('#apply-motion').scroll_into_view_if_needed()
                shot('ui-preview-pending-1440')
                page.locator('#apply-motion').click()
                expect(page.locator('#motion-change-title')).to_have_text('设置已应用')
                assert snapshot()['motion']['drift_radius_meters']==4
                assert snapshot()['position']==paused['position']
                expect(page.locator('#motion-change-detail')).to_contain_text('继续后推进')
                page.locator('#clear-route').click()
                expect(page.locator('#draft-notice')).to_contain_text('草稿已修改')
                assert snapshot()['route_id']==before['route_id']
                expect(page.locator('#apply')).to_have_text('继续')
                page.locator('#active-route-card').scroll_into_view_if_needed()
                shot('ui-preview-draft-1440')
                page.locator('#load-active-route').click()
                expect(page.locator('#point-count')).to_have_text('4')
                expect(page.locator('#draft-notice')).to_contain_text('草稿与执行路线一致')
                page.locator('#restart-route').click()
                expect(page.locator('#restart-dialog')).to_be_visible()
                page.keyboard.press('Delete')
                expect(page.locator('#point-count')).to_have_text('4')
                page.locator('#cancel-restart').click()
                assert snapshot()['route_id']==before['route_id']
                page.locator('#restart-route').click()
                page.locator('#confirm-restart').click()
                expect(page.locator('#apply')).to_have_text('暂停')
                assert snapshot()['route_id']>before['route_id']
                page.locator('#apply').click()
                expect(page.locator('#apply')).to_have_text('继续')
                paused=snapshot()
                page.reload(wait_until='networkidle')
                expect(page.locator('#point-count')).to_have_text('4')
                expect(page.locator('#drift-radius')).to_have_value('4')
                expect(page.locator('#apply')).to_have_text('继续')
                assert snapshot()['position']==paused['position']
                expect(page.locator('#map-view')).not_to_contain_text('NaN')
                page.locator('#apply').click()
                expect(page.locator('#apply')).to_have_text('暂停')
                page.locator('#motion-section').scroll_into_view_if_needed()
                shot('ui-preview-running-1440')
                page.set_viewport_size({'width':390,'height':720})
                page.locator('#apply-motion').evaluate("e=>e.closest('details').scrollIntoView({block:'start'})")
                assert page.evaluate('document.documentElement.scrollWidth')==390
                expect(page.locator('#apply')).to_be_in_viewport()
                expect(page.locator('#restore')).to_be_in_viewport()
                shot('ui-preview-390')
                page.set_viewport_size({'width':1280,'height':720})
                page.locator('#restore').click()
                expect(page.locator('#apply')).to_have_text('开始模拟')
                import_route({**route,'closed':False,'laps':1,'points':[[38,114.52],[38.00002,114.52]],'motion':{'mode':'speed','speed':10}})
                page.locator('#apply').click()
                expect(page.locator('#apply')).to_have_text('结束并恢复定位',timeout=10000)
                expect(page.locator('#restore')).to_be_hidden()
                page.locator('#apply').click()
                expect(page.locator('#active-route-card')).to_be_hidden()
                # Failed setting changes must retain the unapplied state.
                import_route(route)
                page.locator('#apply').click()
                expect(page.locator('#apply')).to_have_text('暂停')
                page.locator('#drift-radius').evaluate("e=>{e.value='3';e.dispatchEvent(new Event('input',{bubbles:true}));}")
                page.route('**/api/motion',lambda r:r.fulfill(status=500,content_type='application/json',body='{"error":"模拟设置失败"}'))
                page.locator('#apply-motion').click()
                expect(page.locator('#toast')).to_contain_text('模拟设置失败')
                expect(page.locator('#motion-change-title')).to_have_text('有未应用的设置')
                assert snapshot()['motion']['drift_radius_meters']==2
                page.unroute('**/api/motion')
                page.locator('#restore').click()
                # A connection failure disables all sending controls until a successful poll.
                page.route('**/api/status',lambda r:r.abort())
                expect(page.locator('#apply')).to_have_text('控制台离线',timeout=6000)
                expect(page.locator('#apply')).to_be_disabled()
                page.unroute('**/api/status')
                expect(page.locator('#apply')).to_have_text('开始模拟',timeout=6000)
                page.locator('#exit').click()
                expect(page.locator('#apply')).to_have_text('已退出')
                expect(page.locator('#transport-title')).to_have_text('程序已退出')
                assert not errors,errors
                browser.close()
                print('PASS: guided modes, primary controls, dirty settings, failure retention, active draft, restart, reload, endpoint, offline recovery and responsive screenshots')
        finally:
            server.terminate()
            server.wait(timeout=15)

if __name__=='__main__':main()
