import pytest
from calc import add


def test_adds():
    assert add(1, 2) == 3


def test_wrong():
    assert add(2, 2) == 5


@pytest.mark.parametrize("a,b,s", [(1, 1, 2), (2, 3, 6)])
def test_param(a, b, s):
    assert add(a, b) == s


class TestCalc:
    def test_method(self):
        assert add(0, 0) == 0
