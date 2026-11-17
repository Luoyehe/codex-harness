"""The portable cache migration cases repeated with real root tree ownership."""
import os
import sys
import unittest
from tests.deploy import test_toolchain as fixtures


@unittest.skipUnless(sys.platform == 'linux' and os.geteuid() == 0, 'Real Linux root ownership fixture')
class RootToolchainTests(fixtures.ToolchainTests):
    pass


if __name__ == '__main__':
    unittest.main()
