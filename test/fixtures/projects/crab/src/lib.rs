pub fn add(a: i32, b: i32) -> i32 { a + b }

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn adds() {
        assert_eq!(add(1, 2), 3);
    }

    #[test]
    fn subtracts() {
        assert_eq!(add(2, 2), 5);
    }

    mod inner {
        #[test]
        fn adds() {
            assert_eq!(super::super::add(1, 1), 3);
        }
    }
}
