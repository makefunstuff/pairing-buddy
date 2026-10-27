const std = @import("std");

test "util fails" {
    try std.testing.expect(1 == 2);
}
