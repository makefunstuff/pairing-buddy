CFLAGS = -std=c11 -Wall -Wextra -Wconversion -O1

probe: main.c table.c table.h
	$(CC) $(CFLAGS) -o $@ main.c table.c

run: probe
	./probe
