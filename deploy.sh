#!/bin/bash
bun build ./src --compile --outfile commit-ia-task
sudo mv commit-ia-task /usr/bin