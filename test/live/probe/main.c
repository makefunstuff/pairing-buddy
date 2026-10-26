// Puts 1000 random keys in a table that starts at 1024 slots and prints how many slots a put looks at on average.
#include <stdio.h>
#include <stdlib.h>
#include "table.h"

int main(void) {
    Table t = table_new(1024);
    srand(1);
    for (int k = 0; k < 1000; k++) table_put(&t, (unsigned)rand());
    double avg = (double)t.probes / 1000;
    printf("len %zu  cap %zu  avg probe %.1f\n", t.len, t.cap, avg);
    table_free(&t);
    if (avg >= 3.0) {
        fprintf(stderr, "main.c:14: avg probe %.1f, want under 3\n", avg);
        return 1;
    }
    return 0;
}
