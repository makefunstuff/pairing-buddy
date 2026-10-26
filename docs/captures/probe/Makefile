CFLAGS = -g -O0 -Wall -fsanitize=address

run: probe
	./probe

probe: probe.c
	cc $(CFLAGS) -o probe probe.c
