// probe: how well does the table spread its keys?
#include <stdio.h>

#define CAP 1024
#define N 700

static unsigned keys[CAP];
static unsigned char used[CAP];

static unsigned hash(unsigned key) {
  return (key * 31) & (CAP - 1);
}

static int insert(unsigned key) {
  unsigned i = hash(key);
  int probes = 1;
  while (used[i]) { i = (i + 1) & (CAP - 1); probes++; }
  used[i] = 1;
  keys[i] = key;
  return probes;
}

int main(void) {
  long total = 0;
  for (unsigned e = 0; e < N; e++) total += insert(e * 64);
  printf("%u keys  avg probe %.1f\n", N, (double)total / N);
  return 0;
}
