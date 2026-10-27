#include <stdio.h>
#include <stdlib.h>
int main(int c, char **v) { if (atoi(v[1])) { fprintf(stderr, "t.c:3: expected 1, got 2\n"); return 1; } return 0; }
