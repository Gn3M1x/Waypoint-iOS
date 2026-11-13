import json
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from app import Runtime, make_handler


class ActiveRouteHTTPTests(unittest.TestCase):
    def test_route_geometry_requires_the_same_authentication_as_status(self):
        with tempfile.TemporaryDirectory() as folder:
            runtime=Runtime(demo=True)
            server=ThreadingHTTPServer(('127.0.0.1',0),make_handler(runtime,'test-token',lambda:None,folder))
            thread=threading.Thread(target=server.serve_forever,daemon=True)
            thread.start()
            try:
                url=f'http://127.0.0.1:{server.server_port}/api/active-route'
                for headers in ({},{'Authorization':'Bearer wrong'},
                                {'Authorization':'Bearer test-token','Origin':'https://example.com'}):
                    with self.assertRaises(urllib.error.HTTPError) as error:
                        urllib.request.urlopen(urllib.request.Request(url,headers=headers))
                    self.assertEqual(error.exception.code,403)
                runtime.call(runtime.engine.dispatch('connect',{'device':'demo-only'}))
                runtime.call(runtime.engine.dispatch('route',{'points':[[0,0],[0,0.01]],'closed':True,'laps':2}))
                with urllib.request.urlopen(urllib.request.Request(url,headers={'Authorization':'Bearer test-token'})) as response:
                    route=json.load(response)['route']
                self.assertEqual(route['points'],[[0,0],[0,0.01]])
                self.assertEqual(route['laps'],2)
            finally:
                server.shutdown();thread.join();server.server_close();runtime.close()
