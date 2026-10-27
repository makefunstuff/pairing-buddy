const std = @import("std");

fn add(a: i32, b: i32) i32 {
    return a + b;
}

test "add" {
    try std.testing.expectEqual(3, add(1, 2));
}

test "add wrong" {
    try std.testing.expectEqual(5, add(2, 2));
}
